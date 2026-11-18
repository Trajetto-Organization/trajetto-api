import type { Prisma, PrismaClient } from "@prisma/client";
import { container } from "tsyringe";

import { databaseBatch } from "@/../infra/database";
import { env } from "@/env";
import { archiveStorageFromEnv } from "@/shared/archive/archive-storage";
import type { ArchiveStorage } from "@/shared/archive/archive-storage";
import { deleteTrailArchive } from "@/shared/archive/trail-archive";
import type { JobContext, JobHandler } from "@/shared/jobs/job-runner";
import { logger } from "@/shared/logging/logger";
import type { NotificationService } from "@/shared/services/notification-service";

import {
  PURGE_BATCH_START,
  PURGE_PARENTS_PER_BATCH,
  PURGE_SCAN_CHUNK,
  PURGE_TRANSACTION_SETTINGS,
  TENANT_PURGE_TRANSACTION_MS,
  childrenBatchSql,
  directBatchSql,
  isLockBusy,
  isOutOfTime,
  nextBatchSize,
  parentsPageSql,
  scanBatchSql,
  scanChunkSql,
} from "./purge-batch";
import {
  TENANT_PURGE_PLAN,
  isDeletingStep,
  type DeletingStep,
  type PurgeStep,
} from "./purge-plan";

const log = logger.child({ component: "jobs", kind: "TENANT_OFFBOARD" });

/**
 * The TENANT_OFFBOARD job (plano-escala F3-26a): the purge of a company a
 * MASTER scheduled (F3-25), or deleted with the e-mailed code (the old
 * "Deletar", which now goes through here too), in short transactions on
 * the maintenance pool — the trajetto_batch login after the cut of the
 * roles — instead of one DELETE that held every row of the company for as
 * long as the cascade took.
 *
 * Its phases, each resumed from the job's cursor after a SIGKILL:
 *
 *  1. lock: SELECT … FOR UPDATE on the company, and PURGING in the same
 *     transaction — only from SCHEDULED with `purge_after` reached. A
 *     reactivation (cancel-business-purge) is one conditional UPDATE on the
 *     same row: whichever commits first wins, and the loser sees it. The
 *     MASTER who reactivated first finds the company whole (the job ends
 *     without deleting anything); one who clicks after the PURGING commit
 *     reads 409 BUSINESS_PURGE_RUNNING. Never half a company alive;
 *  2. rows: the plan (purge-plan.ts), step by step, batch by batch, each
 *     batch with the cursor in its own transaction of at most
 *     TENANT_PURGE_TRANSACTION_MS (purge-batch.ts); the GPS trail only with
 *     TENANT_PURGE_TRAIL_NOW, otherwise it leaves by the DROP of its days;
 *  3. trail-archive: the company's archived trail objects and their
 *     manifest rows (deleteTrailArchive). Without the archive configured,
 *     the nightly housekeeping takes them once it is;
 *  4. finish: the company's other jobs, and the company itself: PURGED,
 *     a tombstone without the responsible person's contact (the MASTER's
 *     list says the data is gone) — or removed, for the old "Deletar" of an
 *     empty company, which frees its CNPJ as it always did. A line in the
 *     platform's audit trail says when.
 *
 * The objects of the uploads bucket go in their own phase (r2-purge.ts,
 * F3-26b).
 */

type OffboardPhase = "rows" | "trail-archive" | "finish" | "done";

interface OffboardProgress {
  v: 1;
  phase: OffboardPhase;

  /** The plan's step the rows phase is on. */
  step: number;

  /** The step's cursor: the last parent id, or the last key scanned. */
  cursor: string;

  /** The size of the step's next batch. */
  batch: number;

  /** Rows deleted so far, and the longest transaction (ms). */
  deleted: number;
  maxTransactionMs: number;
}

interface OffboardPayload {
  businessId: string;
  scheduledById?: string | null;

  /** The old "Deletar": the company's row goes too, not a tombstone. */
  removeRow?: boolean;
}

/** What the job reads and writes through; the tests pass their own. */
interface TenantOffboardDeps {
  db: Pick<
    PrismaClient,
    | "$transaction"
    | "$queryRaw"
    | "$executeRaw"
    | "$queryRawUnsafe"
    | "$executeRawUnsafe"
  >;
  archiveStorage: () => ArchiveStorage | null;
  trailNow: () => boolean;
  activities: () => Pick<NotificationService, "createActivityIfEnabled">;
}

/**
 * How often a row lock is asked again when busy, in a row: the company's
 * at the start, a batch's rows later. Past it the attempt fails and the
 * runner retries the job with its backoff.
 */
const LOCK_ATTEMPTS = 3;
const LOCK_RETRY_PAUSE_MS = 1_000;

/** The responsible person of a tombstone: no name, no contact. */
const TOMBSTONE_RESPONSIBLE = "Removido";

function freshProgress(): OffboardProgress {
  return {
    v: 1,
    phase: "rows",
    step: 0,
    cursor: "",
    batch: PURGE_BATCH_START,
    deleted: 0,
    maxTransactionMs: 0,
  };
}

function progressOf(value: unknown): OffboardProgress | null {
  if (typeof value !== "object" || value === null) return null;

  const progress = value as Partial<OffboardProgress>;

  if (progress.v !== 1 || typeof progress.phase !== "string") return null;

  return { ...freshProgress(), ...progress } as OffboardProgress;
}

function payloadOf(job: JobContext): OffboardPayload {
  const payload = (job.payload ?? {}) as Partial<OffboardPayload>;
  const businessId = payload.businessId ?? job.businessId;

  if (typeof businessId !== "string" || businessId.length === 0) {
    throw new Error("TENANT_OFFBOARD sem businessId");
  }

  return {
    businessId,
    scheduledById: payload.scheduledById ?? null,
    removeRow: payload.removeRow === true,
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Tx = Prisma.TransactionClient;

/**
 * Runs `work` in one purge transaction: the SET LOCALs first, Prisma's
 * timeout around it. Answers what `work` answered and how long it took.
 */
async function purgeTransaction<T>(
  deps: TenantOffboardDeps,
  work: (tx: Tx) => Promise<T>,
): Promise<{ value: T; tookMs: number }> {
  const started = Date.now();
  const value = await deps.db.$transaction(
    async (tx) => {
      for (const setting of PURGE_TRANSACTION_SETTINGS) {
        await tx.$executeRawUnsafe(setting);
      }

      return work(tx);
    },
    {
      timeout: TENANT_PURGE_TRANSACTION_MS,
      maxWait: TENANT_PURGE_TRANSACTION_MS,
    },
  );

  return { value, tookMs: Date.now() - started };
}

interface CompanyRow {
  purge_state: string | null;
  due: boolean;
  corporate_reason: string;
}

type LockOutcome = "purge" | "resume" | "skip";

/**
 * Phase 1: the company's row under FOR UPDATE, and PURGING written with
 * the job's first cursor in the same transaction. "skip": nothing to
 * delete (reactivated, already purged, gone).
 */
async function lockForPurge(
  deps: TenantOffboardDeps,
  job: JobContext,
  businessId: string,
): Promise<LockOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { value } = await purgeTransaction(deps, async (tx) => {
        const [company] = await tx.$queryRaw<CompanyRow[]>`
          SELECT "purge_state"::text AS "purge_state",
                 ("purge_after" IS NOT NULL AND "purge_after" <= now()) AS "due",
                 "corporate_reason"
          FROM "business"
          WHERE "id" = ${businessId}
          FOR UPDATE
        `;

        if (!company) return "skip" as const;

        if (company.purge_state === "PURGING") return "resume" as const;

        if (company.purge_state !== "SCHEDULED" || !company.due) {
          return "skip" as const;
        }

        await tx.$executeRaw`
          UPDATE "business"
          SET "purge_state" = 'PURGING'::"BusinessPurgeState",
              "is_active" = false,
              "updated_at" = now()
          WHERE "id" = ${businessId}
        `;

        await job.checkpoint(freshProgress(), tx);

        return "purge" as const;
      });

      return value;
    } catch (error) {
      if (!isLockBusy(error) || attempt >= LOCK_ATTEMPTS) throw error;

      await pause(LOCK_RETRY_PAUSE_MS);
      job.throwIfStopped();
    }
  }
}

/** Whether a table exists in the session's schema. */
async function tableExists(
  deps: TenantOffboardDeps,
  table: string,
): Promise<boolean> {
  const [row] = await deps.db.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass(quote_ident(${table})) IS NOT NULL AS "present"
  `;

  return row?.present === true;
}

/** Whether the step deletes in this run. */
function runsNow(step: PurgeStep, deps: TenantOffboardDeps): boolean {
  if (!isDeletingStep(step)) return false;

  return !step.trail || deps.trailNow();
}

interface BatchOutcome {
  deleted: number;

  /** The step's cursor after the batch; null when the step is done. */
  cursor: string | null;
}

/** One batch of `step` inside `tx`. */
async function runBatch(
  tx: Tx,
  step: DeletingStep,
  businessId: string,
  cursor: string,
  size: number,
): Promise<BatchOutcome> {
  const deletedBy = async (sql: Prisma.Sql) => {
    const [row] = await tx.$queryRaw<Array<{ deleted: number }>>(sql);

    return Number(row?.deleted ?? 0);
  };

  if (step.kind === "direct") {
    const deleted = await deletedBy(directBatchSql(step, businessId, size));

    return { deleted, cursor: deleted < size ? null : cursor };
  }

  if (step.kind === "children") {
    const parents = await tx.$queryRaw<Array<{ id: string; value: string }>>(
      parentsPageSql(step, businessId, cursor, PURGE_PARENTS_PER_BATCH),
    );

    if (parents.length === 0) return { deleted: 0, cursor: null };

    const values = parents
      .map((parent) => parent.value)
      .filter((value): value is string => typeof value === "string");
    const deleted =
      values.length === 0
        ? 0
        : await deletedBy(childrenBatchSql(step, values, size));

    // A full batch may have left rows under these parents: the same page
    // again. Otherwise the page is done.
    return {
      deleted,
      cursor: deleted < size ? parents[parents.length - 1].id : cursor,
    };
  }

  const [chunk] = await tx.$queryRaw<Array<{ upto: string | null }>>(
    scanChunkSql(step, cursor, PURGE_SCAN_CHUNK),
  );

  if (!chunk?.upto) return { deleted: 0, cursor: null };

  const deleted = await deletedBy(
    scanBatchSql(step, businessId, cursor, chunk.upto),
  );

  return { deleted, cursor: chunk.upto };
}

/**
 * Phase 2: every step of the plan from the cursor's, batch by batch, each
 * batch committed with the next cursor.
 */
async function purgeRows(
  deps: TenantOffboardDeps,
  job: JobContext,
  businessId: string,
  progress: OffboardProgress,
): Promise<OffboardProgress> {
  let current = progress;
  let busy = 0;

  while (current.step < TENANT_PURGE_PLAN.length) {
    const step = TENANT_PURGE_PLAN[current.step];
    const next = (): OffboardProgress => ({
      ...current,
      step: current.step + 1,
      cursor: "",
      batch: PURGE_BATCH_START,
    });

    if (
      !runsNow(step, deps) ||
      (isDeletingStep(step) &&
        step.optional &&
        !(await tableExists(deps, step.table)))
    ) {
      current = next();
      continue;
    }

    const deleting = step as DeletingStep;

    job.throwIfStopped();

    try {
      const { value, tookMs } = await purgeTransaction(deps, async (tx) => {
        const outcome = await runBatch(
          tx,
          deleting,
          businessId,
          current.cursor,
          current.batch,
        );
        const after: OffboardProgress =
          outcome.cursor === null
            ? { ...next(), deleted: current.deleted + outcome.deleted }
            : {
                ...current,
                cursor: outcome.cursor,
                deleted: current.deleted + outcome.deleted,
              };

        await job.checkpoint(after, tx);

        return after;
      });

      busy = 0;
      current = {
        ...value,
        batch:
          value.step === current.step
            ? nextBatchSize(current.batch, tookMs)
            : value.batch,
        maxTransactionMs: Math.max(current.maxTransactionMs, tookMs),
      };
    } catch (error) {
      if (isOutOfTime(error) && current.batch > 1) {
        // Rolled back whole, cursor included: the same rows, half as many.
        current = {
          ...current,
          batch: Math.max(1, Math.floor(current.batch / 2)),
        };
        log.warn(
          { jobId: job.id, table: step.table, batch: current.batch },
          "purge batch ran out of time; retrying with fewer rows",
        );
        continue;
      }

      if (isLockBusy(error)) {
        busy += 1;

        if (busy < LOCK_ATTEMPTS) {
          await pause(LOCK_RETRY_PAUSE_MS);
          continue;
        }
      }

      throw error;
    }
  }

  return { ...current, phase: "trail-archive", cursor: "" };
}

/** Phase 3: the company's archived trail, objects and manifest rows. */
async function purgeTrailArchive(
  deps: TenantOffboardDeps,
  job: JobContext,
  businessId: string,
): Promise<void> {
  const storage = deps.archiveStorage();

  if (!storage) {
    const [row] = await deps.db.$queryRaw<Array<{ archived: number }>>`
      SELECT count(*)::int AS "archived" FROM "archive_manifest"
      WHERE "businessId" = ${businessId}
        AND "status" <> 'SKIPPED'::"ArchiveObjectStatus"
    `;

    if (Number(row?.archived ?? 0) > 0) {
      log.error(
        { jobId: job.id, businessId, objects: row?.archived },
        "purged company has archived trail objects but the archive is not configured; the nightly housekeeping removes them once it is",
      );
    }

    return;
  }

  const deleted = await deleteTrailArchive(businessId, {
    db: deps.db as PrismaClient,
    storage,
  });

  log.info(
    { jobId: job.id, businessId, objects: deleted },
    "purged company's trail archive removed",
  );
}

/**
 * Phase 4: the company's other jobs, then the company itself — the
 * tombstone or, for the old "Deletar", the row — and the audit line, in
 * one transaction with the last cursor.
 */
async function finishPurge(
  deps: TenantOffboardDeps,
  job: JobContext,
  payload: OffboardPayload,
  progress: OffboardProgress,
): Promise<void> {
  const { businessId } = payload;

  await purgeTransaction(deps, async (tx) => {
    const [company] = await tx.$queryRaw<Array<{ corporate_reason: string }>>`
      SELECT "corporate_reason" FROM "business"
      WHERE "id" = ${businessId}
      FOR UPDATE
    `;

    await tx.$executeRaw`
      DELETE FROM "background_job"
      WHERE "businessId" = ${businessId} AND "id" <> ${job.id}
    `;

    if (company) {
      if (payload.removeRow) {
        await tx.$executeRaw`DELETE FROM "business" WHERE "id" = ${businessId}`;
      } else {
        await tx.$executeRaw`
          UPDATE "business"
          SET "purge_state" = 'PURGED'::"BusinessPurgeState",
              "is_active" = false,
              "responsible_name" = ${TOMBSTONE_RESPONSIBLE},
              "telephone" = '',
              "email" = ${`excluida-${businessId}@example.invalid`},
              "erp_code" = NULL,
              "complement" = NULL,
              "updated_at" = now()
          WHERE "id" = ${businessId}
        `;
      }

      await deps.activities().createActivityIfEnabled(
        {
          type: "Empresa",
          action: "delete",
          entityId: businessId,
          description: `Dados da empresa ${company.corporate_reason} apagados (${progress.deleted} registro(s))`,
          status: "Deletado",
          performedBy: null,
          businessId: null,
          tenantName: company.corporate_reason,
        },
        tx,
      );
    }

    await job.checkpoint({ ...progress, phase: "done" }, tx);
  });

  log.info(
    {
      jobId: job.id,
      businessId,
      deleted: progress.deleted,
      maxTransactionMs: progress.maxTransactionMs,
      removed: payload.removeRow === true,
    },
    "company purged",
  );
}

function createTenantOffboardJob(deps: TenantOffboardDeps): JobHandler {
  return {
    async run(job) {
      const payload = payloadOf(job);
      let progress = progressOf(job.progress);

      if (!progress) {
        const outcome = await lockForPurge(deps, job, payload.businessId);

        if (outcome === "skip") {
          log.info(
            { jobId: job.id, businessId: payload.businessId },
            "purge not due or reactivated; nothing deleted",
          );
          return;
        }

        progress = freshProgress();
      }

      if (progress.phase === "rows") {
        progress = await purgeRows(deps, job, payload.businessId, progress);
        await job.checkpoint(progress);
      }

      if (progress.phase === "trail-archive") {
        job.throwIfStopped();
        await purgeTrailArchive(deps, job, payload.businessId);
        progress = { ...progress, phase: "finish" };
        await job.checkpoint(progress);
      }

      // "done" was written with the company's last change: a run that died
      // before the runner settled the job only has the job to settle.
      if (progress.phase === "finish") {
        await finishPurge(deps, job, payload, progress);
      }
    },
  };
}

/** The job as the runner registers it: the maintenance pool, the env. */
const tenantOffboardJob: JobHandler = createTenantOffboardJob({
  db: databaseBatch,
  archiveStorage: () =>
    env.TRAIL_ARCHIVE_ENABLED ? archiveStorageFromEnv(env) : null,
  trailNow: () => env.TENANT_PURGE_TRAIL_NOW,
  activities: () =>
    container.resolve<NotificationService>("NotificationService"),
});

export {
  TOMBSTONE_RESPONSIBLE,
  createTenantOffboardJob,
  freshProgress,
  tenantOffboardJob,
};
export type { OffboardPayload, OffboardProgress, TenantOffboardDeps };
