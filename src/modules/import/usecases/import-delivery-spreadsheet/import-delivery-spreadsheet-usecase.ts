import { inject, injectable } from "tsyringe";
import { v7 as uuidV7 } from "uuid";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IShipperRepository } from "@/modules/shipper/repositories/IShipper-repository";
import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";

import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IImportRepository } from "../../repositories/IImport-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";

import { inspectSpreadsheet } from "@/shared/delivery/spreadsheet-reader";
import { readSpreadsheetOffThread } from "../../services/spreadsheet-worker";
import {
  IMPORT_RETRY_AFTER_SECONDS,
  importQueue as defaultImportQueue,
  type ImportQueue,
} from "../../services/import-queue";
import {
  advanceImportProgress,
  emptyImportProgress,
  importObjectContentType,
  importObjectKey,
  parseImportPayload,
  parseImportProgress,
  rowResultFor,
  type BuiltGroup,
  type RowCode,
  type SpreadsheetImportProgress,
} from "../../services/durable-import";
import {
  parseDeliverySpreadsheet,
  type ParsedRow,
} from "@/shared/delivery/spreadsheet-parser";

import { AppError } from "@/shared/errors/AppError";

import type {
  ImportRecord,
  ImportReport,
  ImportRowResult,
} from "../../dtos/import-dto";

import {
  businessNotFound,
  callerNotFound,
} from "@/shared/delivery/caller-not-found";
import database from "@/../infra/database";
import { businessToday, resolveTimeZone } from "@/shared/time/business-day";
import { Prisma } from "@prisma/client";
import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import {
  RouteCodeTakenError,
  RouteDriverInactiveError,
} from "@/modules/route/usecases/errors/route-errors";
import { crewIssues } from "@/modules/route/usecases/shared/route-crew";
import { OUT_OF_OPERATION_LABELS } from "@/shared/route/route-rules";
import { announceRouteCreated } from "@/shared/route/route-realtime";
import { assertDriverStillActive } from "@/modules/route/usecases/shared/driver-still-active";
import { ShipperInactiveError } from "@/modules/shipper/usecases/errors/shipper-errors";
import { logger } from "@/shared/logging/logger";
import { countDeliveriesCreated } from "@/shared/health/volume-gauge";
import {
  deliveryAssignedPayload,
  deliveryEventPayload,
} from "@/shared/integration/announce";
import { env } from "@/env";
import { ServiceBusyError } from "@/shared/errors/service-busy-error";
import type { IBackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import {
  JobLeaseLostError,
  JobStoppedError,
  PermanentJobError,
} from "@/shared/jobs/job-errors";
import type { FailedJob, JobContext } from "@/shared/jobs/job-runner";
import { wakeJobsAfterCommit } from "@/shared/jobs/job-wake";
import type { UploadService } from "@/shared/services/upload-service";

interface ImportDeliverySpreadsheetRequest {
  userId: string;
  businessId: string;

  filename: string;

  /** The file itself, base64 — same shape the XML import already takes. */
  content: string;

  /**
   * One upload is one shipper's load.
   *
   * A spreadsheet has no fiscal issuer to read the cargo owner from, the way
   * an NF-e does, and asking the dispatcher to repeat it on every one of two
   * hundred rows would be asking them to get it wrong once. A file mixing
   * shippers is two uploads.
   */
  shipperId: string;
}

/**
 * How often a running upload proves it is alive.
 *
 * Far inside the sweep's staleness window (close-abandoned-imports-job): even
 * a slow database decides twenty-five rows in seconds, not minutes.
 */
const HEARTBEAT_EVERY_ROWS = 25;

/**
 * A batch's transaction (plano-escala F3-23c). A hundred rows are a second
 * or two of inserts; the margin is for a database under load, far below the
 * 4 minutes a writer of delivery_event may hold one (U-16). Past it the
 * batch rolls back and is redone row by row.
 */
const IMPORT_BATCH_TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 10_000 };

/**
 * The import queue asked the running upload to stop: the replica is shutting
 * down (import-queue.ts). Thrown between two rows, caught by `process`.
 */
class ImportStoppedError extends Error {
  constructor() {
    super("import stopped: the replica is shutting down");
    this.name = "ImportStoppedError";
  }
}

/** What an upload has decided so far — readable when it is interrupted. */
interface ImportProgress {
  rows: ImportRowResult[];

  /** The sheet line being processed; null once every row is decided. */
  line: number | null;
}

/**
 * The durable job's own stops: it was asked to stop (SIGTERM) or lost its
 * lease. Never a row's failure: they end the run, and the runner hands the
 * job back or leaves it to its new owner.
 */
function isJobControlError(error: unknown): boolean {
  return error instanceof JobLeaseLostError || error instanceof JobStoppedError;
}

/**
 * How a durable import builds its routes: the groups an earlier attempt
 * already built are taken from its cursor, and a group built now writes
 * itself to the cursor inside its own transaction.
 */
interface RouteResume {
  built: Record<string, BuiltGroup>;
  save: (
    key: string,
    group: BuiltGroup,
    tx: Prisma.TransactionClient,
  ) => Promise<void>;
  committed: (key: string, group: BuiltGroup) => void;
  throwIfStopped: () => void;
}

/** The delivery a spreadsheet row creates. */
function deliveryOfRow(
  row: ParsedRow,
  {
    businessId,
    shipperId,
    importId,
  }: { businessId: string; shipperId: string; importId: string },
) {
  return {
    businessId,
    shipperId,
    importId,

    // The "Tipo" column. The parser always read it; until the meeting of
    // 14/10/2026 nothing wrote it, and a "coleta" row was created as an
    // "Entrega".
    kind: row.kind,

    recipient_name: row.recipient_name,
    recipient_document: row.recipient_document,
    recipient_telephone: row.recipient_telephone,
    recipient_email: row.recipient_email,

    cep: row.cep,
    city: row.city,
    uf: row.uf,
    street: row.street,
    address_number: row.address_number,
    complement: row.complement,
    neighborhood: row.neighborhood,

    // The sheet's point (plan of 02/11/2026, E1): stored as the address
    // point, MANUAL; without it the geocoder finds it.
    latitude: row.latitude,
    longitude: row.longitude,

    invoice_key: row.invoice_key,
    invoice_number: row.invoice_number,
    code: row.code,

    scheduled_date: row.scheduled_date,
    notes: row.notes,

    ...(row.item && {
      items: [
        {
          description: row.item.description,
          quantity: row.item.quantity,
          unit: row.item.unit,
          unit_value: row.item.unit_value,
        },
      ],
    }),
  };
}

/**
 * The delivery of an imported row the durable cursor must keep: one with a
 * route and neither an NF-e key nor an order number, which a resumed run
 * cannot find again by its identity.
 */
function keylessRouted(
  row: ParsedRow,
  deliveryId: string,
): { line: number; deliveryId: string } | undefined {
  return row.route && !row.invoice_key && !row.code
    ? { line: row.line, deliveryId }
    : undefined;
}

/** A route the import built, with what its rows were told. */
function builtGroupOf(
  built: { id: string; code: number; name: string | null; stops: unknown[] },
  notes: string[],
): BuiltGroup {
  return {
    route: {
      id: built.id,
      code: built.code,
      name: built.name,
      stops: built.stops.length,
    },
    notes: [...notes],
  };
}

/** What the rows of one route group have in common. */
function routeKeyOf(row: ParsedRow): string {
  const route = row.route!;

  return [
    route.name ?? "",
    route.date ? route.date.toISOString() : "",
    route.driverCnh ?? "",
    route.vehiclePlate ?? "",
  ].join("|");
}

/**
 * The first client's way in without an integration.
 *
 * Three rules carried over from the XML import, for the same reasons:
 *
 *  - **One bad row never sinks the batch.** Every row is decided on its own
 *    and reported individually. An import that refuses two hundred deliveries
 *    over one cell is an import people stop using, and then they phone the
 *    numbers in instead.
 *  - **Re-importing the same file is a no-op**, reported as duplicated rather
 *    than as an error: the operator who is not sure whether the upload went
 *    through will click again, and that has to be safe.
 *  - **The report is stored**, not only returned. "Which of the two hundred
 *    failed?" is asked hours later by somebody who did not do the upload.
 *
 * And one that is new here: the route columns CREATE the route, with the rows
 * as its stops in the order they appear in the sheet. That is the order the
 * dispatcher typed, and the order they meant.
 */
@injectable()
class ImportDeliverySpreadsheetUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("ShipperRepository")
    private shipper: IShipperRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("ImportRepository")
    private importRepository: IImportRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
    // The durable import (plano-escala F3-23a): the job queue and the
    // storage its file goes to. Optional for the suites that only drive
    // the in-memory path.
    @inject("BackgroundJobRepository")
    private jobs?: IBackgroundJobRepository,
    @inject("UploadService")
    private uploads?: Pick<
      UploadService,
      "putObject" | "readObject" | "tryDeleteFile"
    >,
  ) {}

  /**
   * The whole upload, start to finish, in the caller's time: validated, read,
   * every row decided and the record closed before it returns. What the
   * suites drive; the HTTP route uses `start`, which answers first.
   */
  async execute(
    request: ImportDeliverySpreadsheetRequest,
  ): Promise<ImportRecord> {
    const { timeZone } = await this.validate(request);

    const parsed = parseDeliverySpreadsheet(
      await this.readMatrix(request.filename, request.content),
    );

    const record = await this.openRecord(request);

    return this.process(record, parsed, { ...request, timeZone });
  }

  /**
   * The upload as the HTTP route runs it: validated and opened now, processed
   * after the answer (import-queue.ts).
   *
   * Everything that can be refused without reading the rows is refused here,
   * with the request still open: the caller, the company, the shipper, a
   * full replica (429 IMPORT_BUSY), a file too big or not a spreadsheet
   * (400/413 from the cheap inspection). Then the record is opened — the
   * id the client follows — and the workbook is loaded and the rows decided
   * in the background, one upload at a time per replica. A file that passes
   * the inspection but cannot be read after all closes its record with that
   * sentence on line 1, instead of answering a request that is long gone.
   */
  async start(
    request: ImportDeliverySpreadsheetRequest,
    queue: ImportQueue = defaultImportQueue,
  ): Promise<ImportRecord> {
    if (env.IMPORT_DURABLE_JOBS) return this.startDurable(request);

    const { timeZone } = await this.validate(request);

    // After the checks that answer 403/404, before anything is written.
    const ticket = queue.reserve();

    let record: ImportRecord;

    try {
      try {
        inspectSpreadsheet(request.filename, request.content);
      } catch (error) {
        throw this.unreadable(error);
      }

      record = await this.openRecord(request);
    } catch (error) {
      ticket.cancel();

      throw error;
    }

    const { businessId } = request;

    // Whether the run got past reading the file. Before that nothing can be
    // written once it was asked to stop (the first row checks the signal);
    // from then on a row's commit may still land after a hand-back's count.
    let reachedRows = false;

    ticket.submit({
      importId: record.id,
      heartbeat: () => this.importRepository.touchImport(record.id, businessId),
      run: async (signal) => {
        let parsed: ReturnType<typeof parseDeliverySpreadsheet>;

        try {
          parsed = parseDeliverySpreadsheet(
            await this.readMatrix(request.filename, request.content),
          );
        } catch (error) {
          await this.closeUnreadable(record.id, businessId, error);

          return;
        }

        reachedRows = true;

        await this.process(record, parsed, { ...request, timeZone }, signal);
      },
      // The replica is shutting down (import-queue.ts): closed now, with
      // the deliveries counted from the rows, instead of after the sweep. A
      // big workbook still being read when the stop grace ran out created
      // nothing, and its report says so instead of "estorne".
      abandon: async (stage) => {
        await this.importRepository.closeInterruptedImport(
          record.id,
          businessId,
          stage === "waiting" || !reachedRows ? "not-started" : "stopped",
        );
      },
    });

    return record;
  }

  /** The caller, the company and the shipper; the company's zone. */
  private async validate({
    userId,
    businessId,
    shipperId,
  }: ImportDeliverySpreadsheetRequest): Promise<{ timeZone: string }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw callerNotFound();

    // Loading the company's day is the dispatcher's job.
    assertDispatcher(findUser);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) throw businessNotFound();

    const findShipper = await this.shipper.findShipperById(shipperId);

    // Same 404 for "does not exist" and "is not yours".
    if (!findShipper || findShipper.businessId !== businessId) {
      throw new AppError(
        "Embarcador não encontrado.",
        404,
        "SHIPPER_NOT_FOUND",
      );
    }

    // A deactivated shipper takes no new deliveries through any door
    // (decision 5.7); the whole upload is its load, so it is refused whole.
    if (findShipper.is_active === false) {
      throw new ShipperInactiveError(findShipper.name);
    }

    // The company's zone: a route row without a date is scheduled for the
    // company's today, not the server's (decision 1.1).
    return {
      timeZone: resolveTimeZone(
        (findBusiness as { timezone?: string | null }).timezone,
      ),
    };
  }

  /**
   * The file as a matrix of cells, or the sentence that says why not. Read
   * on a worker thread with a heap ceiling of its own (spreadsheet-worker.ts):
   * a workbook too heavy for it says so in the report instead of taking the
   * replica down.
   */
  private async readMatrix(
    filename: string,
    content: string,
  ): Promise<unknown[][]> {
    try {
      return await readSpreadsheetOffThread(filename, content);
    } catch (error) {
      throw this.unreadable(error);
    }
  }

  private unreadable(error: unknown): AppError {
    // Refused on purpose, with its own sentence (too many rows, too large).
    if (error instanceof AppError) return error;

    // A corrupt file, or an .xlsx that is not one. The operator needs to
    // know it was the FILE and not their data.
    return new AppError(
      "Não foi possível ler a planilha. Confira se o arquivo é .xlsx ou .csv e se não está corrompido.",
      400,
      "SPREADSHEET_UNREADABLE",
    );
  }

  /**
   * The record exists before a single row does, so everything created later
   * carries its id from birth. A process that dies halfway then leaves an
   * upload the operator can still undo — once it is closed, by `process` or
   * by the close-abandoned-imports sweep; stamping the rows at the end would
   * leave orphans no undo could ever group again.
   */
  private openRecord({
    userId,
    businessId,
    filename,
  }: ImportDeliverySpreadsheetRequest): Promise<ImportRecord> {
    return this.importRepository.createImport({
      source: "SPREADSHEET",
      filename,
      businessId,
      performedById: userId,
    });
  }

  /**
   * The rows of an opened record, closing it whatever happens. `signal`
   * (the import queue's, on shutdown) stops it at the next row.
   */
  private async process(
    record: ImportRecord,
    parsed: ReturnType<typeof parseDeliverySpreadsheet>,
    {
      userId,
      businessId,
      shipperId,
      filename,
      timeZone,
    }: ImportDeliverySpreadsheetRequest & { timeZone: string },
    signal?: AbortSignal,
  ): Promise<ImportRecord> {
    const progress: ImportProgress = { rows: [], line: null };

    try {
      return await this.importRows(
        record,
        parsed,
        progress,
        {
          userId,
          businessId,
          shipperId,
          filename,
          timeZone,
        },
        signal,
      );
    } catch (error) {
      // A failure the process survives — a pool timeout on a lookup, the
      // database dropping the connection — used to leave the upload
      // IN_PROGRESS for good, and the undo refuses a running upload: the rows
      // it had created could never be taken back (IDEMP-10). It is closed
      // here with what it did, and the line it stopped at.
      await this.closeInterrupted(
        record.id,
        businessId,
        parsed,
        progress,
        error instanceof ImportStoppedError ? "shutdown" : "failure",
      );

      // Stopping on shutdown is not a failure to log as one: the record
      // already says what happened.
      if (error instanceof ImportStoppedError) return record;

      throw error;
    }
  }

  /**
   * Closes a queued upload whose file could not be read after all (it passed
   * the cheap inspection, then the load refused it): COMPLETED, nothing
   * created, the reason on line 1 where sheet-level problems go — what the
   * request would have answered with, had it still been open.
   */
  private async closeUnreadable(
    importId: string,
    businessId: string,
    error: unknown,
  ): Promise<void> {
    const reason: ImportRowResult = {
      line: 1,
      outcome: "invalid",
      recipient_name: null,
      reference: null,
      message: this.unreadable(error).message,
    };

    await this.importRepository
      .finishImport(importId, businessId, {
        imported: 0,
        duplicated: 0,
        invalid: 1,
        report: {
          imported: 0,
          duplicated: 0,
          invalid: 1,
          unknownHeaders: [],
          rows: [reason],
          routes: [],
        },
      })
      .catch((failure) => {
        logger.error(
          { err: failure, importId },
          "could not close an unreadable import; the abandoned-import sweep will",
        );
      });
  }

  /** The rows, the routes and the closing of the record, in that order. */
  private async importRows(
    record: ImportRecord,
    parsed: ReturnType<typeof parseDeliverySpreadsheet>,
    progress: ImportProgress,
    {
      userId,
      businessId,
      shipperId,
      filename,
      timeZone,
    }: Omit<ImportDeliverySpreadsheetRequest, "content"> & { timeZone: string },
    signal?: AbortSignal,
  ): Promise<ImportRecord> {
    const rows = progress.rows;

    rows.push(
      ...parsed.errors.map((error) => ({
        line: error.line,
        outcome: "invalid" as const,
        recipient_name: null,
        reference: error.column,
        message: error.message,
      })),
    );

    const createdDeliveryIdByLine = new Map<number, string>();

    for (const [index, row] of parsed.rows.entries()) {
      progress.line = row.line;

      // The replica is shutting down: stop between two rows — each row is
      // its own commit, so everything before this line is whole — and let
      // `process` close the record from here.
      if (signal?.aborted) throw new ImportStoppedError();

      // The heartbeat: what tells a long upload that is alive from one whose
      // process died, for the close-abandoned-imports sweep.
      if (index > 0 && index % HEARTBEAT_EVERY_ROWS === 0) {
        await this.importRepository.touchImport(record.id, businessId);
      }

      const decided = await this.importRow(row, {
        businessId,
        shipperId,
        importId: record.id,
      });

      if (decided.deliveryId) {
        createdDeliveryIdByLine.set(row.line, decided.deliveryId);
      }

      rows.push(rowResultFor(row, decided.code));
    }

    // Every row is decided; what can still fail now is the routes.
    progress.line = null;

    const routes = await this.buildRoutes(
      userId,
      businessId,
      record.id,
      parsed.rows,
      createdDeliveryIdByLine,
      rows,
      timeZone,
    );

    return this.closeRecord(record.id, {
      userId,
      businessId,
      filename,
      rows,
      routes,
      unknownHeaders: parsed.unknownHeaders,
    });
  }

  /**
   * Closes the record with the report — every row decided and the routes
   * built — and says so in the activity log. The same for the upload run
   * in memory and for the durable job.
   */
  private async closeRecord(
    importId: string,
    {
      userId,
      businessId,
      filename,
      rows,
      routes,
      unknownHeaders,
    }: {
      userId: string;
      businessId: string;
      filename: string;
      rows: ImportRowResult[];
      routes: ImportReport["routes"];
      unknownHeaders: ImportReport["unknownHeaders"];
    },
  ): Promise<ImportRecord> {
    const report: ImportReport = {
      imported: rows.filter((row) => row.outcome === "imported").length,
      duplicated: rows.filter((row) => row.outcome === "duplicated").length,
      invalid: rows.filter((row) => row.outcome === "invalid").length,
      unknownHeaders,

      // Sorted by line so the report reads like the file the operator is
      // looking at, rather than like the order the code happened to process.
      rows: rows.sort((left, right) => left.line - right.line),
      routes,
    };

    const finished = await this.importRepository.finishImport(
      importId,
      businessId,
      {
        imported: report.imported,
        duplicated: report.duplicated,
        invalid: report.invalid,
        report,
      },
    );

    this.notificationService.createActivityIfEnabled({
      type: "Entrega",
      action: "create",
      entityId: importId,
      description:
        `Planilha "${filename}" importada: ${report.imported} entrega(s), ` +
        `${report.duplicated} duplicada(s), ${report.invalid} com erro`,
      status: "Importada",
      performedBy: userId,
      businessId,
    });

    return { ...finished, report };
  }

  /**
   * Closes an upload whose processing threw, with what it had done.
   *
   * The record becomes COMPLETED with the rows decided so far and one line
   * naming where it stopped — which is what the undo accepts. finishImport
   * only closes a record still IN_PROGRESS, so a failure after the record was
   * already closed changes nothing. When even this write fails (the database
   * is gone), the upload stays IN_PROGRESS and close-abandoned-imports closes
   * it once its heartbeat is stale.
   */
  private async closeInterrupted(
    importId: string,
    businessId: string,
    parsed: ReturnType<typeof parseDeliverySpreadsheet>,
    progress: ImportProgress,
    cause: "failure" | "shutdown" = "failure",
  ): Promise<void> {
    // What stopped it, in the operator's words: a deploy is not a fault.
    const stoppedBy =
      cause === "shutdown"
        ? "pelo reinício do servidor"
        : "por uma falha do servidor";

    // Stopped by the shutdown between two rows before any was created (it
    // finished reading the file only after it was asked to stop): nothing
    // to undo. Only for the shutdown, whose stop never lands mid-row.
    const nothingCreated =
      cause === "shutdown" &&
      !progress.rows.some((row) => row.outcome === "imported");

    const interruption: ImportRowResult =
      progress.line !== null
        ? {
            line: progress.line,
            outcome: "invalid",
            recipient_name: null,
            reference: null,
            message: nothingCreated
              ? `Importação interrompida ${stoppedBy} nesta linha: ela e ` +
                "as seguintes não foram processadas e nenhuma entrega foi " +
                "criada. Envie o arquivo de novo."
              : `Importação interrompida ${stoppedBy} nesta linha: ` +
                "ela e as seguintes não foram processadas. Estorne esta " +
                "importação e envie o arquivo de novo.",
          }
        : {
            // Every row was decided; the routes were being built. Line 1,
            // where sheet-level problems go.
            line: 1,
            outcome: "invalid",
            recipient_name: null,
            reference: null,
            message:
              `Importação interrompida ${stoppedBy} ao montar as ` +
              "rotas: as entregas foram criadas, mas podem ter ficado sem " +
              "rota. Estorne esta importação e envie o arquivo de novo.",
          };

    const rows = [...progress.rows, interruption].sort(
      (left, right) => left.line - right.line,
    );

    const count = (outcome: ImportRowResult["outcome"]) =>
      rows.filter((row) => row.outcome === outcome).length;

    await this.importRepository
      .finishImport(importId, businessId, {
        imported: count("imported"),
        duplicated: count("duplicated"),
        invalid: count("invalid"),
        report: {
          imported: count("imported"),
          duplicated: count("duplicated"),
          invalid: count("invalid"),
          unknownHeaders: parsed.unknownHeaders,
          rows,
          routes: [],
        },
      })
      .catch((error) => {
        logger.error(
          { err: error, importId },
          "could not close an interrupted import; the abandoned-import sweep will",
        );
      });
  }

  /**
   * One row, decided: a duplicate is answered from the reads, a new one is
   * created with its `delivery.created` in one commit of its own — one bad
   * row still never sinks the batch. `beforeCommit` runs inside that
   * transaction once the delivery exists (the durable job's fenced
   * cursor): it commits with the row, or neither does.
   */
  private async importRow(
    row: ParsedRow,
    {
      businessId,
      shipperId,
      importId,
    }: { businessId: string; shipperId: string; importId: string },
    beforeCommit?: (
      tx: Prisma.TransactionClient,
      deliveryId: string,
    ) => Promise<void>,
  ): Promise<{ code: RowCode; deliveryId: string | null }> {
    if (await this.findDuplicate(businessId, shipperId, row)) {
      return { code: "d", deliveryId: null };
    }

    // Identified by the order alone: no unique index stands behind the pair
    // (ADR 0006), so the check above is repeated under a lock inside the
    // insert's transaction.
    const orderOnly = !row.invoice_key && row.code ? row.code : null;

    try {
      // The row and its `delivery.created` in one commit, per row. The
      // spreadsheet used to announce nothing, and the company's ERP never
      // learned these documents' ids.
      const created = await database.$transaction(async (tx) => {
        if (orderOnly) {
          // Two uploads of the same sheet both pass the check above before
          // either commits. The lock makes the second wait for the first's
          // commit, and the re-read then sees its row.
          await this.delivery.lockOrderIdentity(
            businessId,
            shipperId,
            orderOnly,
            tx,
          );

          const existing = await this.delivery.findDeliveryByShipperAndCode(
            businessId,
            shipperId,
            orderOnly,
            tx,
          );

          if (existing) return null;
        }

        const delivery = await this.delivery.createDelivery(
          deliveryOfRow(row, { businessId, shipperId, importId }),
          tx,
        );

        await this.webhooks.announce(
          "delivery.created",
          businessId,
          deliveryEventPayload({ ...delivery, id: delivery.id! }),
          tx,
        );

        await beforeCommit?.(tx, delivery.id!);

        return delivery;
      });

      // Another upload won this order: a duplicate, and not on our route.
      if (!created) return { code: "d", deliveryId: null };

      // After the row's commit; a row another upload won is not ours.
      countDeliveriesCreated();

      return { code: "i", deliveryId: created.id! };
    } catch (error) {
      if (isJobControlError(error)) throw error;

      // For a row with an access key, the unique index on (businessId,
      // invoice_key) is the real guard: two operators importing the same
      // file at the same moment collide in the database, not in the check
      // above. Order-only rows are guarded by the lock instead, and never
      // land here as duplicates.
      const isDuplicateKey =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002";

      return { code: isDuplicateKey ? "d" : "x", deliveryId: null };
    }
  }

  /**
   * The upload as a durable job (plano-escala F3-23a, IMPORT_DURABLE_JOBS).
   *
   * Refused now what can be refused without the rows, as `start` does
   * (403/404, 400/413 from the cheap inspection). Then the file goes to
   * storage (spreadsheetImports/, written by the server: the web does not
   * change) and, in ONE transaction under the company's cap, the record is
   * opened and the job enqueued: past IMPORT_RUNNING_PER_TENANT +
   * IMPORT_QUEUED_PER_TENANT live imports the upload is refused with 429
   * IMPORT_BUSY and nothing is left behind (the stored file is deleted).
   * The process that consumes the `jobs` queue runs it (`runJob`).
   */
  private async startDurable(
    request: ImportDeliverySpreadsheetRequest,
  ): Promise<ImportRecord> {
    const { timeZone } = await this.validate(request);
    const { userId, businessId, filename, content, shipperId } = request;

    try {
      inspectSpreadsheet(filename, content);
    } catch (error) {
      throw this.unreadable(error);
    }

    const jobs = this.jobs;
    const uploads = this.uploads;

    if (!jobs || !uploads) {
      throw new Error(
        "durable import: the job queue or the storage is missing",
      );
    }

    const importId = uuidV7();
    const objectKey = importObjectKey(businessId, importId, filename);

    // A storage that does not answer is the 503 STORAGE_UNAVAILABLE (with
    // Retry-After) of every server write: nothing was opened.
    await uploads.putObject(
      objectKey,
      Buffer.from(content, "base64"),
      importObjectContentType(objectKey),
    );

    let outcome: Awaited<
      ReturnType<IBackgroundJobRepository["enqueueWithCap"]>
    >;

    try {
      outcome = await jobs.enqueueWithCap({
        kind: "SPREADSHEET_IMPORT",
        businessId,
        subjectId: importId,
        payload: {
          importId,
          objectKey,
          filename,
          shipperId,
          userId,
          timeZone,
        },
        limit: env.IMPORT_RUNNING_PER_TENANT + env.IMPORT_QUEUED_PER_TENANT,
        prepare: async (tx) => {
          await this.importRepository.createImport(
            {
              id: importId,
              source: "SPREADSHEET",
              filename,
              businessId,
              performedById: userId,
            },
            tx,
          );
        },
      });
    } catch (error) {
      await uploads.tryDeleteFile(objectKey);

      throw error;
    }

    if (outcome.outcome === "busy") {
      await uploads.tryDeleteFile(objectKey);

      throw new ServiceBusyError(
        "Há muitas importações desta empresa na fila agora. Tente de novo em instantes.",
        "IMPORT_BUSY",
        IMPORT_RETRY_AFTER_SECONDS,
        429,
      );
    }

    wakeJobsAfterCommit();

    const record = await this.importRepository.findImportById(
      importId,
      businessId,
    );

    if (!record)
      throw new Error("durable import: the record just opened is gone");

    return record;
  }

  /**
   * The durable import's job (spreadsheet-import-job.ts): reads the stored
   * file, decides the rows from the cursor, builds the routes and closes the
   * record. Each row that creates a delivery commits it with the cursor
   * past it (the job's fenced checkpoint), so a run killed anywhere resumes
   * on another process at the first row not committed, and the report it
   * writes is the one the killed run would have written. A stop (SIGTERM)
   * or a lost lease ends the run at the next row; any other failure is the
   * runner's to retry, the record still IN_PROGRESS (the abandoned-import
   * sweep leaves an upload with a live job alone).
   */
  async runJob(job: JobContext): Promise<void> {
    const payload = parseImportPayload(job.payload);
    const businessId = job.businessId;

    if (!payload || !businessId) {
      throw new PermanentJobError("durable import: malformed job payload");
    }

    const { importId, objectKey, filename, shipperId, userId, timeZone } =
      payload;

    const record = await this.importRepository.findImportById(
      importId,
      businessId,
    );

    if (!record) throw new PermanentJobError("durable import: record is gone");

    // Closed already: by this job before its process died between the
    // report and the end, or by an operator's undo of the closed report.
    if (record.status !== "IN_PROGRESS") {
      await this.releaseObject(objectKey);
      return;
    }

    const uploads = this.uploads;

    if (!uploads) throw new Error("durable import: the storage is missing");

    const bytes = await uploads.readObject(objectKey);

    if (!bytes) {
      throw new PermanentJobError("durable import: the stored file is gone");
    }

    let parsed: ReturnType<typeof parseDeliverySpreadsheet>;

    try {
      parsed = parseDeliverySpreadsheet(
        await this.readMatrix(filename, bytes.toString("base64")),
      );
    } catch (error) {
      // The file itself: closed with the sentence, as the in-memory path.
      await this.closeUnreadable(importId, businessId, error);
      await this.releaseObject(objectKey);

      return;
    }

    const resumed =
      job.progress === null ? null : parseImportProgress(job.progress);

    if (job.progress !== null && resumed === null) {
      throw new PermanentJobError("durable import: unreadable cursor");
    }

    if (resumed && resumed.next > parsed.rows.length) {
      throw new PermanentJobError("durable import: cursor past the file");
    }

    let progress = await this.decideRowsDurably(
      job,
      parsed,
      resumed ?? emptyImportProgress(),
      { businessId, shipperId, importId },
    );

    // Every row is decided. The report's lines, rebuilt from the outcomes
    // (this run's and the earlier attempts'), then the routes.
    const rows: ImportRowResult[] = [
      ...parsed.errors.map((error) => ({
        line: error.line,
        outcome: "invalid" as const,
        recipient_name: null,
        reference: error.column,
        message: error.message,
      })),
      ...parsed.rows.map((row, index) =>
        rowResultFor(row, progress.outcomes[index] as RowCode),
      ),
    ];

    const createdDeliveryIdByLine = await this.importedDeliveriesByLine(
      importId,
      businessId,
      parsed.rows,
      progress,
    );

    const routes = await this.buildRoutes(
      userId,
      businessId,
      importId,
      parsed.rows,
      createdDeliveryIdByLine,
      rows,
      timeZone,
      {
        built: progress.routes,
        save: async (key, group, tx) => {
          await job.checkpoint(
            { ...progress, routes: { ...progress.routes, [key]: group } },
            tx,
          );
        },
        committed: (key, group) => {
          progress = {
            ...progress,
            routes: { ...progress.routes, [key]: group },
          };
        },
        throwIfStopped: () => job.throwIfStopped(),
      },
    );

    job.throwIfStopped();

    await this.closeRecord(importId, {
      userId,
      businessId,
      filename,
      rows,
      routes,
      unknownHeaders: parsed.unknownHeaders,
    });

    await this.releaseObject(objectKey);
  }

  /**
   * The durable import's job failed for good (its attempts ran out, or its
   * file is gone): the record closes with the deliveries it created counted
   * and a line saying why. The stored file stays seven days for whoever
   * looks into it (import-object-release.ts).
   */
  async closeFailedJob(job: FailedJob): Promise<void> {
    const payload = parseImportPayload(job.payload);

    if (!payload || !job.businessId) return;

    await this.importRepository.closeInterruptedImport(
      payload.importId,
      job.businessId,
      "failed",
    );
  }

  /**
   * The rows from the cursor on (plano-escala F3-23a and F3-23c): in
   * batches of IMPORT_ROWS_PER_TRANSACTION, each one a transaction with its
   * deliveries, their webhook rows and the cursor past it, so a run killed
   * anywhere resumes at the first batch not committed. A batch that fails
   * as a whole (a key another upload took in the meantime, a timeout) is
   * redone row by row, the way of before, each row its own commit with the
   * cursor; 1 is that way throughout.
   */
  private async decideRowsDurably(
    job: JobContext,
    parsed: ReturnType<typeof parseDeliverySpreadsheet>,
    from: SpreadsheetImportProgress,
    context: { businessId: string; shipperId: string; importId: string },
  ): Promise<SpreadsheetImportProgress> {
    const perTransaction = Math.max(1, env.IMPORT_ROWS_PER_TRANSACTION);
    let progress = from;

    while (progress.next < parsed.rows.length) {
      job.throwIfStopped();

      const start = progress.next;
      const end = Math.min(start + perTransaction, parsed.rows.length);

      if (perTransaction > 1) {
        // Alive, for the abandoned-import sweep and the screen.
        await this.importRepository.touchImport(
          context.importId,
          context.businessId,
        );

        try {
          progress = await this.importBatch(
            job,
            parsed.rows,
            { start, end },
            progress,
            context,
          );

          continue;
        } catch (error) {
          if (isJobControlError(error)) throw error;

          // Nothing of the batch committed: it is decided again row by
          // row, the rows that would still fail failing alone.
          logger.warn(
            { err: error, importId: context.importId, start, end },
            "import batch failed; redoing it row by row",
          );
        }
      }

      progress = await this.decideRowsOneByOne(
        job,
        parsed.rows,
        { start, end },
        progress,
        context,
      );
    }

    await job.checkpoint(progress);

    return progress;
  }

  /**
   * One row at a time, each one that creates a delivery committing it with
   * the cursor past it. The outcomes of rows that create nothing
   * (duplicates, failures) go down with the next commit, or every
   * HEARTBEAT_EVERY_ROWS rows: deciding one again after a crash gives the
   * same answer and writes nothing.
   */
  private async decideRowsOneByOne(
    job: JobContext,
    rows: ParsedRow[],
    { start, end }: { start: number; end: number },
    from: SpreadsheetImportProgress,
    context: { businessId: string; shipperId: string; importId: string },
  ): Promise<SpreadsheetImportProgress> {
    let progress = from;

    for (let index = start; index < end; index += 1) {
      job.throwIfStopped();

      if (index > 0 && index % HEARTBEAT_EVERY_ROWS === 0) {
        await this.importRepository.touchImport(
          context.importId,
          context.businessId,
        );
        await job.checkpoint(progress);
      }

      const row = rows[index];
      const committed: { progress: SpreadsheetImportProgress | null } = {
        progress: null,
      };

      const decided = await this.importRow(
        row,
        context,
        async (tx, deliveryId) => {
          committed.progress = advanceImportProgress(
            progress,
            index,
            "i",
            keylessRouted(row, deliveryId),
          );

          await job.checkpoint(committed.progress, tx);
        },
      );

      progress =
        decided.code === "i" && committed.progress
          ? committed.progress
          : advanceImportProgress(progress, index, decided.code);
    }

    return progress;
  }

  /**
   * A batch of rows in one transaction (plano-escala F3-23c), deciding each
   * row as the row-by-row path would:
   *
   *  - the duplicates are read for the whole batch at once (the NF-e keys,
   *    the orders of the rows without a key), and decided in sheet order
   *    with what the rows before each one create, as the one-row check sees
   *    the rows committed before it;
   *  - the orders the batch creates are locked in one order (sorted, so two
   *    uploads of overlapping files queue instead of deadlocking) and read
   *    again under the locks: one another upload created meanwhile is a
   *    duplicate here too;
   *  - the deliveries, their `delivery.created` rows (announceMany) and the
   *    cursor past the batch commit together. Any failure rolls the whole
   *    batch back and the caller redoes it row by row.
   */
  private async importBatch(
    job: JobContext,
    rows: ParsedRow[],
    { start, end }: { start: number; end: number },
    from: SpreadsheetImportProgress,
    {
      businessId,
      shipperId,
      importId,
    }: { businessId: string; shipperId: string; importId: string },
  ): Promise<SpreadsheetImportProgress> {
    const batch = rows.slice(start, end);
    const unique = (values: string[]) => [...new Set(values)];

    const [knownKeys, knownOrders] = await Promise.all([
      this.delivery.findExistingInvoiceKeys(
        businessId,
        unique(
          batch.flatMap((row) => (row.invoice_key ? [row.invoice_key] : [])),
        ),
      ),
      this.delivery.findExistingOrderCodes(
        businessId,
        shipperId,
        unique(
          batch.flatMap((row) =>
            !row.invoice_key && row.code ? [row.code] : [],
          ),
        ),
      ),
    ]);

    const seenKeys = new Set(knownKeys);
    const seenOrders = new Set(knownOrders);

    const plan = batch.map((row) => {
      if (row.invoice_key) {
        if (seenKeys.has(row.invoice_key)) return { row, create: false };

        seenKeys.add(row.invoice_key);
        if (row.code) seenOrders.add(row.code);

        return { row, create: true };
      }

      if (row.code) {
        if (seenOrders.has(row.code)) return { row, create: false };

        seenOrders.add(row.code);
      }

      return { row, create: true };
    });

    const orderOnly = unique(
      plan.flatMap(({ row, create }) =>
        create && !row.invoice_key && row.code ? [row.code] : [],
      ),
    ).sort();

    const { progress, created } = await database.$transaction(async (tx) => {
      for (const code of orderOnly) {
        await this.delivery.lockOrderIdentity(businessId, shipperId, code, tx);
      }

      const lost = await this.delivery.findExistingOrderCodes(
        businessId,
        shipperId,
        orderOnly,
        tx,
      );

      const decided: Array<{ code: RowCode; deliveryId: string | null }> = [];
      const payloads: Array<Record<string, unknown>> = [];

      for (const { row, create } of plan) {
        if (!create || (!row.invoice_key && row.code && lost.has(row.code))) {
          decided.push({ code: "d", deliveryId: null });
          continue;
        }

        const delivery = await this.delivery.createDelivery(
          deliveryOfRow(row, { businessId, shipperId, importId }),
          tx,
        );

        payloads.push(deliveryEventPayload({ ...delivery, id: delivery.id! }));
        decided.push({ code: "i", deliveryId: delivery.id! });
      }

      await this.webhooks.announceMany(
        "delivery.created",
        businessId,
        payloads,
        tx,
      );

      const next = decided.reduce(
        (current, { code, deliveryId }, offset) =>
          advanceImportProgress(
            current,
            start + offset,
            code,
            deliveryId ? keylessRouted(batch[offset], deliveryId) : undefined,
          ),
        from,
      );

      await job.checkpoint(next, tx);

      return { progress: next, created: payloads.length };
    }, IMPORT_BATCH_TRANSACTION_OPTIONS);

    // After the commit.
    countDeliveriesCreated(created);

    return progress;
  }

  /**
   * The delivery of every imported row with a route, by its line: found by
   * the NF-e key or the order number among the upload's deliveries (an
   * earlier attempt's rows included), or, for a row with neither, from the
   * cursor.
   */
  private async importedDeliveriesByLine(
    importId: string,
    businessId: string,
    parsedRows: ParsedRow[],
    progress: SpreadsheetImportProgress,
  ): Promise<Map<number, string>> {
    const byLine = new Map<number, string>();

    if (
      !parsedRows.some(
        (row, index) => row.route && progress.outcomes[index] === "i",
      )
    ) {
      return byLine;
    }

    const identities = await this.importRepository.listImportedIdentities(
      importId,
      businessId,
    );
    const byKey = new Map<string, string>();
    const byCode = new Map<string, string>();

    for (const identity of identities) {
      if (identity.invoice_key) byKey.set(identity.invoice_key, identity.id);
      if (identity.code) byCode.set(identity.code, identity.id);
    }

    parsedRows.forEach((row, index) => {
      if (!row.route || progress.outcomes[index] !== "i") return;

      const id = row.invoice_key
        ? byKey.get(row.invoice_key)
        : row.code
          ? byCode.get(row.code)
          : progress.keyless[String(row.line)];

      if (id) byLine.set(row.line, id);
    });

    return byLine;
  }

  /** Deletes the stored file; a failure is left to the nightly release. */
  private async releaseObject(objectKey: string): Promise<void> {
    await this.uploads?.tryDeleteFile(objectKey);
  }

  /**
   * The access key when there is one, the order number when there is not.
   *
   * Two different identities because two different files: a company that
   * issues invoices has the key, and one that works from orders does not —
   * and refusing the second would refuse the client this whole feature exists
   * for.
   */
  private async findDuplicate(
    businessId: string,
    shipperId: string,
    row: ParsedRow,
  ): Promise<string | null> {
    if (row.invoice_key) {
      const existing = await this.delivery.findDeliveryByInvoiceKey(
        businessId,
        row.invoice_key,
      );

      return existing ? "Esta nota já havia sido importada." : null;
    }

    if (row.code) {
      const existing = await this.delivery.findDeliveryByShipperAndCode(
        businessId,
        shipperId,
        row.code,
      );

      return existing
        ? "Este pedido já havia sido importado para este embarcador."
        : null;
    }

    // Neither a key nor an order number: nothing to be the same as. Importing
    // it twice is the operator's call, and the report will show two lines.
    return null;
  }

  /**
   * Turns the route columns into routes, one per group, stops in sheet order.
   *
   * A group whose driver or vehicle cannot be found does NOT sink its
   * deliveries: they were imported and they are fine, they simply have no
   * route. The report says so on every line of the group, which is what lets
   * the dispatcher fix the CNH and build the route in the panel.
   *
   * The crew passes the rule the Rotas screen applies (route-crew): an
   * inactive driver gets no route, a vehicle out of operation stays off it.
   * Both used to go through — a planned route for an inactive driver on a
   * blocked truck — because this path built its routes on its own.
   */
  private async buildRoutes(
    userId: string,
    businessId: string,
    importId: string,
    parsedRows: ParsedRow[],
    createdDeliveryIdByLine: Map<number, string>,
    rows: ImportRowResult[],
    timeZone: string,
    resume?: RouteResume,
  ): Promise<ImportReport["routes"]> {
    const groups = new Map<string, ParsedRow[]>();

    for (const row of parsedRows) {
      if (!row.route) continue;
      if (!createdDeliveryIdByLine.has(row.line)) continue;

      const key = routeKeyOf(row);

      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    const created: ImportReport["routes"] = [];

    const note = (line: number, message: string) => {
      const entry = rows.find((row) => row.line === line);

      if (entry) {
        entry.message = entry.message ? `${entry.message} ${message}` : message;
      }
    };

    for (const [groupKey, group] of groups) {
      // Built by an earlier attempt of the durable job: its route and what
      // its rows were told, from the cursor; never built twice.
      const done = resume?.built[groupKey];

      if (done) {
        for (const message of done.notes) {
          for (const row of group) note(row.line, message);
        }

        created.push(done.route);
        continue;
      }

      resume?.throwIfStopped();

      // Still alive, for the abandoned-import sweep: a sheet with many route
      // groups spends a while here after its last row.
      await this.importRepository.touchImport(importId, businessId);

      // What every row of the group is told, kept for the durable cursor.
      const groupNotes: string[] = [];
      const noteGroup = (message: string) => {
        groupNotes.push(message);

        for (const row of group) note(row.line, message);
      };

      const [first] = group;
      const route = first.route!;

      // Scoped to the company: the CNH is unique per company (decision 8.1),
      // so a global lookup could answer with another carrier's driver.
      const findDriver = route.driverCnh
        ? await this.driver.findDriverByCnh(route.driverCnh, businessId)
        : null;

      if (!findDriver) {
        noteGroup(
          `Entrega importada, mas a rota não foi criada: motorista com CNH ${route.driverCnh} não encontrado.`,
        );

        continue;
      }

      const driverInactive = `Entrega importada, mas a rota não foi criada: o motorista com CNH ${route.driverCnh} está inativo.`;

      // As the driver not found: the deliveries stay, without a route.
      if (crewIssues({ driver: findDriver }).length > 0) {
        noteGroup(driverInactive);

        continue;
      }

      let vehicleId: string | null = null;

      if (route.vehiclePlate) {
        // Same reason as the driver: plates are unique per company.
        const findVehicle = await this.vehicle.findVehicleByLicensePlate(
          route.vehiclePlate,
          businessId,
        );

        const [unavailable] = findVehicle
          ? crewIssues({ vehicle: findVehicle })
          : [];

        if (!findVehicle) {
          noteGroup(
            `Rota criada sem veículo: placa ${route.vehiclePlate} não encontrada.`,
          );
        } else if (unavailable?.code === "ROUTE_VEHICLE_UNAVAILABLE") {
          // As the plate not found: the route is built without the truck,
          // for the dispatcher to give it another one before the release.
          noteGroup(
            `Rota criada sem veículo: o veículo ${unavailable.plate} está ` +
              `${OUT_OF_OPERATION_LABELS[unavailable.status]}.`,
          );
        } else {
          vehicleId = findVehicle.id!;
        }
      }

      const deliveryIds = group.map((row) =>
        createdDeliveryIdByLine.get(row.line)!,
      );

      /**
       * The route and a `delivery.assigned` per stop, in one commit — the same
       * unit create-route builds. With the caller's transaction the repository
       * reports a code collision instead of retrying, so the whole unit runs
       * again once, as create-route does.
       */
      const build = () =>
        database.$transaction(async (tx) => {
          // The check above read the status before this transaction; a
          // deactivation committing since is seen here, under the driver
          // row's lock, as the Rotas screen's create does.
          await assertDriverStillActive(this.route, tx, {
            driverId: findDriver.id!,
            businessId,
            refusal: {
              message: new RouteDriverInactiveError().message,
              code: "ROUTE_DRIVER_INACTIVE",
            },
          });

          const built = await this.route.createRoute(
            {
              businessId,
              importId,
              driverId: findDriver.id!,
              vehicleId,
              name: route.name,
              scheduled_date:
                route.date ?? first.scheduled_date ?? businessToday(timeZone),
              deliveryIds,
            },
            tx,
          );

          // The timeline line each delivery gets when it joins a plan, as
          // the Rotas screen writes it: a document's planning history does
          // not depend on which path built its route.
          await this.route.recordPlanEvents(
            tx,
            deliveryIds.map((deliveryId, index) => ({
              deliveryId,
              note: `Adicionada à Rota ${built.code} (parada ${index + 1}).`,
            })),
            {
              type: "ROUTE_ADDED",
              routeId: built.id,
              businessId,
              actorId: userId,
            },
          );

          for (const stop of built.stops) {
            await this.webhooks.announce(
              "delivery.assigned",
              businessId,
              deliveryAssignedPayload(stop.delivery, built),
              tx,
            );
          }

          // The durable job's cursor, with the route: both commit or
          // neither, so a resume never builds this group again.
          await resume?.save(groupKey, builtGroupOf(built, groupNotes), tx);

          return built;
        });

      try {
        let createdRoute;

        try {
          createdRoute = await build();
        } catch (error) {
          if (!(error instanceof RouteCodeTakenError)) throw error;

          createdRoute = await build();
        }

        // Committed: the operations room hears it as it hears a route of the
        // Rotas screen (announceRouteCreated). This path built its routes on
        // its own and told nobody, so a colleague's boards and route pickers
        // never listed them until a reload (audit of 25/11/2026). A group a
        // resumed job finds built was announced by the attempt that built it.
        announceRouteCreated(businessId, createdRoute);

        const builtGroup = builtGroupOf(createdRoute, groupNotes);

        resume?.committed(groupKey, builtGroup);
        created.push(builtGroup.route);
      } catch (error) {
        // The durable job stopping or losing its lease is not this route's
        // failure: nothing of it committed, and the job ends here.
        if (isJobControlError(error)) throw error;

        // Deactivated between the check and the write: said as such.
        const inactive =
          error instanceof AppError && error.code === "ROUTE_DRIVER_INACTIVE";

        noteGroup(
          inactive
            ? driverInactive
            : "Entrega importada, mas a rota não pôde ser criada.",
        );
      }
    }

    return created;
  }
}

export { ImportDeliverySpreadsheetUseCase };
export type { ImportDeliverySpreadsheetRequest };
