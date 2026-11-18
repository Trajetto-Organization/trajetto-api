import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import {
  IImportRepository,
  ReversalRemovedHook,
} from "../../repositories/IImport-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";

import {
  ImportAlreadyReversedError,
  ImportNotFoundError,
  ImportReversalRunningError,
} from "../errors/import-errors";

import { AppError } from "@/shared/errors/AppError";
import type {
  ImportRecord,
  ReversalProgress,
  ReversalResult,
  ReversalView,
} from "../../dtos/import-dto";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { deliveryEventPayload } from "@/shared/integration/announce";
import { logger } from "@/shared/logging/logger";
import { env } from "@/env";
import type { IBackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import { PermanentJobError } from "@/shared/jobs/job-errors";
import type { JobContext } from "@/shared/jobs/job-runner";
import { wakeJobsAfterCommit } from "@/shared/jobs/job-wake";

import {
  importQueue as defaultImportQueue,
  type ImportQueue,
} from "../../services/import-queue";
import {
  REVERSAL_INLINE_LIMIT,
  REVERSAL_STALE_AFTER_MS,
  reversalView,
} from "../../services/import-reversal";

const log = logger.child({ component: "import" });

interface ReverseImportRequest {
  userId: string;
  businessId: string;
  importId: string;
}

/**
 * What the HTTP route answers: the result, when the undo ran inside the
 * request (200), or the upload with the undo's progress, when it continues
 * in the background (202) — including the click that finds one already
 * running, which follows that run instead of starting another.
 */
type ReverseImportOutcome =
  | { kind: "finished"; result: ReversalResult }
  | {
      kind: "accepted";
      record: Pick<ImportRecord, "id" | "status"> & {
        reversal: ReversalView | null;
      };
    };

/**
 * Taking back an upload.
 *
 * The case this exists for: a dispatcher loads the wrong file at 6am —
 * yesterday's sheet, the customer's other branch, a column shifted by one —
 * and needs two hundred deliveries gone. Doing that by hand is not doing it:
 * they will miss some, and the ones they miss go out on a truck.
 *
 * Deliberately PARTIAL rather than all-or-nothing. An upload undone ten
 * minutes later is untouched; one undone at noon has had half its deliveries
 * worked, and refusing the whole undo because three of two hundred are in
 * transit would leave the operator removing the other hundred and ninety-seven
 * by hand — the exact situation this was built to avoid. What was worked
 * stays, named, with the reason.
 *
 * Batched and resumable (services/import-reversal.ts): one transaction for
 * the whole undo timed out at 15 s, and a 2,000-delivery upload could not be
 * undone.
 */
@injectable()
class ReverseImportUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ImportRepository")
    private importRepository: IImportRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
    // The undo as a durable job (plano-escala F3-24). Optional for the
    // suites that only drive the in-memory path.
    @inject("BackgroundJobRepository")
    private jobs?: IBackgroundJobRepository,
  ) {}

  /**
   * The whole undo in the caller's time, every batch before it returns. What
   * the suites drive; the HTTP route uses `start`.
   */
  async execute(request: ReverseImportRequest): Promise<ReversalResult> {
    const record = await this.check(request);
    const claim = await this.claim(request);

    if (claim.outcome === "running") throw new ImportReversalRunningError();

    return this.run(request, record, claim.lease, claim.progress);
  }

  /**
   * The undo as the HTTP route runs it.
   *
   * Up to REVERSAL_INLINE_LIMIT deliveries left, it runs inside the request
   * and answers with the result, as it always did — the everyday undo needs
   * no polling. Past it, it goes to the import queue (one job at a time per
   * replica, the same one the spreadsheet uploads use) and the request
   * answers with the upload and the undo's progress, which the client
   * follows on GET /import/get-import until `status` is REVERSED. The lease
   * is claimed BEFORE answering, so a second click — on this replica or any
   * other — sees the run and follows it instead of starting another.
   */
  async start(
    request: ReverseImportRequest,
    queue: ImportQueue = defaultImportQueue,
  ): Promise<ReverseImportOutcome> {
    const record = await this.check(request);

    // An undo already in the jobs queue (F3-24): this click follows it,
    // whatever is left to remove and wherever the flag stands now.
    if (
      this.jobs &&
      (await this.jobs.findLive("IMPORT_REVERSAL", request.importId))
    ) {
      return { kind: "accepted", record: this.accepted(record) };
    }

    const remaining = await this.importRepository.countImportDeliveries(
      request.importId,
      request.businessId,
    );

    if (remaining <= REVERSAL_INLINE_LIMIT) {
      const claim = await this.claim(request);

      if (claim.outcome === "running") {
        return { kind: "accepted", record: this.accepted(claim.record) };
      }

      return {
        kind: "finished",
        result: await this.run(request, record, claim.lease, claim.progress),
      };
    }

    if (env.IMPORT_DURABLE_JOBS && this.jobs) {
      return this.startJob(request, record, this.jobs);
    }

    // A full replica refuses with 429 IMPORT_BUSY before the lease is taken.
    const ticket = queue.reserve();

    let claim: Awaited<ReturnType<ReverseImportUseCase["claim"]>>;

    try {
      claim = await this.claim(request);
    } catch (error) {
      ticket.cancel();
      throw error;
    }

    if (claim.outcome === "running") {
      ticket.cancel();

      return { kind: "accepted", record: this.accepted(claim.record) };
    }

    const { lease, progress } = claim;
    const { importId, businessId } = request;

    ticket.submit({
      importId,
      heartbeat: () =>
        this.importRepository.touchReversal(importId, businessId, lease),
      run: () =>
        // A failure keeps what the committed batches did and drops the
        // lease (the record reads INTERRUPTED); asking again resumes.
        this.run(request, record, lease, progress).catch((error) =>
          log.error(
            { err: error, importId, businessId },
            "background import reversal stopped; it can be resumed",
          ),
        ),
      // The replica is shutting down (import-queue.ts): the lease goes now,
      // so the record reads INTERRUPTED and asking again — on any replica —
      // resumes at once instead of after REVERSAL_STALE_AFTER_MS. A run still
      // going on this lease fails its next batch, which re-checks it.
      abandon: () =>
        this.importRepository.releaseReversal(importId, businessId, lease),
    });

    return {
      kind: "accepted",
      record: {
        id: record.id,
        status: record.status,
        reversal: {
          state: "RUNNING",
          removedDeliveries: progress.removedDeliveries,
          removedRoutes: progress.removedRoutes,
          keptDeliveries: progress.keptDeliveries,
          keptRoutes: progress.keptRoutes,
          startedAt: progress.startedAt,
          finishedAt: null,
        },
      },
    };
  }

  /**
   * A large undo as a durable job (plano-escala F3-24, IMPORT_DURABLE_JOBS):
   * the lease is taken now, as for the in-memory queue, so the record reads
   * RUNNING at once and a second click — on any replica — follows this one;
   * then the IMPORT_REVERSAL job is enqueued, and the process that consumes
   * the `jobs` queue runs the batches (`runJob`). The 60 s transactions of
   * the batches leave the HTTP process with it.
   */
  private async startJob(
    request: ReverseImportRequest,
    record: ImportRecord,
    jobs: IBackgroundJobRepository,
  ): Promise<ReverseImportOutcome> {
    const claim = await this.claim(request);

    if (claim.outcome === "running") {
      return { kind: "accepted", record: this.accepted(claim.record) };
    }

    const { importId, businessId, userId } = request;

    try {
      await jobs.enqueue({
        kind: "IMPORT_REVERSAL",
        businessId,
        subjectId: importId,
        payload: { importId, userId },
      });
    } catch (error) {
      await this.importRepository
        .releaseReversal(importId, businessId, claim.lease)
        .catch(() => undefined);

      throw error;
    }

    wakeJobsAfterCommit();

    return {
      kind: "accepted",
      record: {
        id: record.id,
        status: record.status,
        reversal: {
          state: "RUNNING",
          removedDeliveries: claim.progress.removedDeliveries,
          removedRoutes: claim.progress.removedRoutes,
          keptDeliveries: claim.progress.keptDeliveries,
          keptRoutes: claim.progress.keptRoutes,
          startedAt: claim.progress.startedAt,
          finishedAt: null,
        },
      },
    };
  }

  /**
   * The IMPORT_REVERSAL job (import-reversal-job.ts): the one run of this
   * undo, so it takes the lease over whatever holds it — the request's that
   * enqueued it, or a run that died — and resumes from the progress the
   * committed batches left on the record. A run the takeover fenced out
   * rolls its batch back. It stops between two batches when asked
   * (SIGTERM): the lease goes, the progress stays, and the job resumes on
   * the next process to claim it.
   */
  async runJob(job: JobContext): Promise<void> {
    const payload = job.payload as { importId?: unknown; userId?: unknown };
    const businessId = job.businessId;

    if (
      !businessId ||
      typeof payload?.importId !== "string" ||
      typeof payload.userId !== "string"
    ) {
      throw new PermanentJobError("import reversal: malformed job payload");
    }

    const request: ReverseImportRequest = {
      importId: payload.importId,
      userId: payload.userId,
      businessId,
    };

    const record = await this.importRepository.findImportById(
      request.importId,
      businessId,
    );

    // Gone, or undone already: nothing left to do.
    if (!record || record.status === "REVERSED") return;

    if (record.status === "IN_PROGRESS") {
      throw new PermanentJobError("import reversal: the upload is running");
    }

    // Any lease is taken over: staleness measured from a minute ahead.
    const claim = await this.importRepository.claimReversal(
      request.importId,
      businessId,
      new Date(Date.now() + 60_000),
    );

    if (claim.outcome === "reversed") return;

    if (claim.outcome !== "claimed") {
      throw new Error(`import reversal: lease not taken (${claim.outcome})`);
    }

    await this.run(request, record, claim.lease, claim.progress, () =>
      job.throwIfStopped(),
    );
  }

  /** The caller, the upload, and whether it can be undone at all. */
  private async check({
    userId,
    businessId,
    importId,
  }: ReverseImportRequest): Promise<ImportRecord> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw callerNotFound();

    assertDispatcher(findUser);

    const findImport = await this.importRepository.findImportById(
      importId,
      businessId,
    );

    // The read is already scoped by company, so another carrier's upload
    // reads as absent — no separate "exists but is not yours" to learn from.
    if (!findImport) {
      throw new ImportNotFoundError();
    }

    // A running import is still writing rows. Undoing one would delete
    // deliveries while the loop above is creating them, and the two would
    // race over the same ids — the report would name rows that no longer
    // exist and the operator would be left with a half-import nobody can
    // account for.
    if (findImport.status === "IN_PROGRESS") {
      throw this.inProgress();
    }

    // Undoing twice would report removing nothing and read like a failure.
    // Saying so is what tells the operator the first click worked.
    if (findImport.status === "REVERSED") {
      throw new ImportAlreadyReversedError();
    }

    return findImport;
  }

  /**
   * The lease. A double click: both passed the check above, and the
   * conditional write let only one of them have it (IDEMP-13); the other
   * finds a live run, or — if the first already finished — a REVERSED
   * upload.
   */
  private async claim({
    businessId,
    importId,
  }: ReverseImportRequest): Promise<
    | { outcome: "claimed"; lease: Date; progress: ReversalProgress }
    | { outcome: "running"; record: ImportRecord }
  > {
    const claim = await this.importRepository.claimReversal(
      importId,
      businessId,
      new Date(Date.now() - REVERSAL_STALE_AFTER_MS),
    );

    switch (claim.outcome) {
      case "claimed":
      case "running":
        return claim;
      case "reversed":
        throw new ImportAlreadyReversedError();
      case "in-progress":
        throw this.inProgress();
      default:
        throw new ImportNotFoundError();
    }
  }

  /** Runs the claimed undo to its end, then writes the trail. */
  private async run(
    { userId, businessId, importId }: ReverseImportRequest,
    record: ImportRecord,
    lease: Date,
    progress: ReversalProgress,
    beforeBatch?: () => void,
  ): Promise<ReversalResult> {
    // Each delivery the upload announced as `delivery.created` and this undo
    // removes is announced as `delivery.cancelled` (decision 5.1), in the
    // deletion's own transaction: an ERP that heard about the delivery must
    // hear it is gone, or it keeps a ghost record billing for it.
    const onRemoved: ReversalRemovedHook = async (removed, tx) => {
      for (const delivery of removed) {
        await this.webhooks.announce(
          "delivery.cancelled",
          businessId,
          deliveryEventPayload({ ...delivery, status: "CANCELLED" }),
          tx,
        );
      }
    };

    const result = await this.importRepository.runReversal(
      importId,
      businessId,
      lease,
      progress,
      { onRemoved, beforeBatch },
    );

    const kept = result.keptDeliveries.length + result.keptRoutes.length;

    this.notificationService.createActivityIfEnabled({
      type: "Entrega",
      action: "delete",
      entityId: importId,
      description:
        `Importação "${record.filename}" estornada: ` +
        `${result.removedDeliveries} entrega(s) e ${result.removedRoutes} rota(s) removida(s)` +
        (kept > 0 ? `, ${kept} mantida(s) por já ter movimento` : ""),
      status: "Estornada",
      performedBy: userId,
      businessId,
    });

    return result;
  }

  private accepted(
    record: ImportRecord,
  ): Extract<ReverseImportOutcome, { kind: "accepted" }>["record"] {
    return {
      id: record.id,
      status: record.status,
      reversal: reversalView(record),
    };
  }

  private inProgress(): AppError {
    return new AppError(
      "Esta importação ainda está em andamento. Aguarde o fim para estorná-la.",
      409,
      "IMPORT_IN_PROGRESS",
    );
  }
}

export { ReverseImportUseCase };
export type { ReverseImportOutcome, ReverseImportRequest };
