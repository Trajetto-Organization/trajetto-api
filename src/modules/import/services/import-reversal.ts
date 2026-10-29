import type {
  ImportRecord,
  RemovedDelivery,
  ReversalClaim,
  ReversalProgress,
  ReversalResult,
  ReversalView,
} from "../dtos/import-dto";
import type {
  IImportRepository,
  ReversalRemovedHook,
} from "../repositories/IImport-repository";
import {
  ImportAlreadyReversedError,
  ImportReversalRunningError,
} from "../usecases/errors/import-errors";

/**
 * Undoing an upload in batches.
 *
 * The undo ran in ONE interactive transaction with Prisma's default 15 s
 * timeout. Undoing a 2,000-delivery upload took 29 s and failed every time,
 * so an upload of 20,000 rows — which the spreadsheet import now accepts —
 * could never be taken back at all. It now runs in transactions of
 * REVERSAL_BATCH_SIZE deliveries, in id order, each one committing its
 * deletions, the webhooks announcing them and the progress on the import
 * record together.
 *
 * What makes that safe:
 *  - the routes are decided ONCE, first, against every delivery of the upload
 *    (a route goes only if every stop on it can go), in a transaction of
 *    their own; the deliveries then only have to ask whether an open stop is
 *    left on a route that stays — the same answer the single transaction
 *    gave, because the routes that go are already gone;
 *  - every batch leaves no row of it pointing at the upload (removed, or cut
 *    loose with the reason), so the next batch is simply "the next ones still
 *    carrying the upload's id", and a retry after a crash starts exactly
 *    where the last commit stopped;
 *  - the record stays COMPLETED until the last batch, which flips it to
 *    REVERSED: REVERSED always means fully undone, and the panel keeps
 *    offering "Estornar" on an undo that stopped halfway, which resumes it;
 *  - one run at a time: a lease (`reversal_started_at`) claimed by a
 *    conditional UPDATE and kept alive by the record's heartbeat
 *    (`updated_at`, the same column the running upload beats on). Every batch
 *    re-checks the lease on the record's row before touching anything, so a
 *    run that lost it — declared dead after REVERSAL_STALE_AFTER_MS of
 *    silence, then woke up — rolls its batch back instead of announcing the
 *    same deliveries twice.
 */
const REVERSAL_BATCH_SIZE = 500;

/**
 * Up to one batch the undo runs inside the request and answers 200 with the
 * result, exactly as it always did: the everyday case (two hundred rows
 * loaded by mistake at 6am) needs no polling, and the panel reads the answer
 * it always read. Past it, the undo goes to the import queue and the request
 * answers 202.
 */
const REVERSAL_INLINE_LIMIT = REVERSAL_BATCH_SIZE;

/**
 * Silence after which a run holding the lease is taken for dead.
 *
 * A running undo beats once per batch (seconds); one waiting in the import
 * queue beats every two minutes (import-queue.ts). Five minutes is past both
 * with room, and short enough that the operator who clicks again after a
 * crash is not left waiting a quarter of an hour.
 */
const REVERSAL_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Each batch's transaction. Prisma's default (15 s) is what failed: a batch
 * is a few seconds, and the margin is for a database under load, not for
 * bigger batches.
 */
const REVERSAL_TRANSACTION_OPTIONS = { timeout: 60_000, maxWait: 10_000 };

/** The reasons the screen shows next to what the undo kept. */
const KEEP_REASON = {
  deliveryLeftPending: "Já saiu do status pendente.",
  deliveryHasEvents: "Já tem registros do motorista.",
  deliveryHasOccurrences: "Já tem ocorrência registrada.",
  deliveryOnKeptRoute: "Está numa rota que não pode ser desfeita.",
  routeNotPlanned: "Já foi liberada ou já saiu.",
  routeWithKeptStops: "Tem paradas de entregas que não puderam ser removidas.",
} as const;

/**
 * Whether a delivery was worked, which keeps it: anything that happened to it
 * means somebody acted on it, and an undo button must not erase that.
 */
function deliveryKeepReason(delivery: {
  status: string;
  events: number;
  occurrences: number;
}): string | null {
  if (delivery.status !== "PENDING") return KEEP_REASON.deliveryLeftPending;
  if (delivery.events > 0) return KEEP_REASON.deliveryHasEvents;
  if (delivery.occurrences > 0) return KEEP_REASON.deliveryHasOccurrences;

  return null;
}

/**
 * Whether a route of the upload stays. One whose stops point at deliveries
 * that cannot go would become a route with holes in it; keeping it whole is
 * the honest outcome — the operator can cancel it.
 */
function routeKeepReason(route: {
  status: string;
  hasStopThatStays: boolean;
}): string | null {
  if (route.status !== "PLANNED") return KEEP_REASON.routeNotPlanned;
  if (route.hasStopThatStays) return KEEP_REASON.routeWithKeptStops;

  return null;
}

function emptyReversalProgress(now: Date): ReversalProgress {
  return {
    removedDeliveries: 0,
    removedRoutes: 0,
    keptDeliveries: [],
    keptRoutes: [],
    routesDone: false,
    startedAt: now.toISOString(),
    finishedAt: null,
  };
}

/** Reads the column back; anything malformed starts over from zero. */
function parseReversalProgress(
  value: unknown,
  now: Date,
): ReversalProgress | null {
  if (!value || typeof value !== "object") return null;

  const raw = value as Partial<ReversalProgress>;

  return {
    ...emptyReversalProgress(now),
    ...raw,
    keptDeliveries: Array.isArray(raw.keptDeliveries) ? raw.keptDeliveries : [],
    keptRoutes: Array.isArray(raw.keptRoutes) ? raw.keptRoutes : [],
  };
}

function reversalResultOf(progress: ReversalProgress): ReversalResult {
  return {
    removedDeliveries: progress.removedDeliveries,
    removedRoutes: progress.removedRoutes,
    keptDeliveries: progress.keptDeliveries,
    keptRoutes: progress.keptRoutes,
  };
}

/**
 * The undo as the client reads it on the record (GET /import/get-import).
 *
 * - DONE: the record is REVERSED; the numbers are the result.
 * - RUNNING: a run holds the lease and beat recently.
 * - INTERRUPTED: it stopped halfway — a failure released the lease, or the
 *   process died and the heartbeat went quiet. What it did is counted, the
 *   record is still COMPLETED, and asking for the undo again resumes it.
 */
function reversalView(
  record: Pick<
    ImportRecord,
    "status" | "reversal" | "reversal_started_at" | "updated_at"
  >,
  now: Date = new Date(),
): ReversalView | null {
  const progress = parseReversalProgress(record.reversal, now);

  if (!progress) return null;

  const heartbeat = record.updated_at
    ? new Date(record.updated_at).getTime()
    : 0;

  const state: ReversalView["state"] =
    record.status === "REVERSED"
      ? "DONE"
      : record.reversal_started_at &&
          now.getTime() - heartbeat < REVERSAL_STALE_AFTER_MS
        ? "RUNNING"
        : "INTERRUPTED";

  return {
    state,
    ...reversalResultOf(progress),
    startedAt: progress.startedAt,
    finishedAt: progress.finishedAt,
  };
}

const NOTHING_REVERSED: ReversalResult = {
  removedDeliveries: 0,
  removedRoutes: 0,
  keptDeliveries: [],
  keptRoutes: [],
};

/**
 * The whole undo in the caller's time: claim, then every batch.
 *
 * What both repositories' `reverseImport` are. Another company's upload, or
 * one still running, touches nothing; an upload already reversed, or being
 * reversed by a live run, is refused.
 */
async function reverseWholeImport(
  repository: Pick<IImportRepository, "claimReversal" | "runReversal">,
  importId: string,
  businessId: string,
  onRemoved?: ReversalRemovedHook,
  options: { batchSize?: number; now?: Date } = {},
): Promise<ReversalResult> {
  const now = options.now ?? new Date();

  const claim: ReversalClaim = await repository.claimReversal(
    importId,
    businessId,
    new Date(now.getTime() - REVERSAL_STALE_AFTER_MS),
  );

  switch (claim.outcome) {
    case "reversed":
      throw new ImportAlreadyReversedError();
    case "running":
      throw new ImportReversalRunningError();
    case "in-progress":
    case "not-found":
      return NOTHING_REVERSED;
    default:
      return repository.runReversal(
        importId,
        businessId,
        claim.lease,
        claim.progress,
        { onRemoved, batchSize: options.batchSize },
      );
  }
}

/** What a removed delivery's webhook carries, out of whatever row held it. */
function removedDeliveryOf(row: {
  id: string;
  code?: string | null;
  invoice_key?: string | null;
  invoice_number?: string | null;
  recipient_name: string;
  city?: string;
  uf?: string;
}): RemovedDelivery {
  return {
    id: row.id,
    code: row.code ?? null,
    invoice_key: row.invoice_key ?? null,
    invoice_number: row.invoice_number ?? null,
    recipient_name: row.recipient_name,
    city: row.city ?? "",
    uf: row.uf ?? "",
  };
}

export {
  KEEP_REASON,
  NOTHING_REVERSED,
  REVERSAL_BATCH_SIZE,
  REVERSAL_INLINE_LIMIT,
  REVERSAL_STALE_AFTER_MS,
  REVERSAL_TRANSACTION_OPTIONS,
  deliveryKeepReason,
  emptyReversalProgress,
  parseReversalProgress,
  removedDeliveryOf,
  reverseWholeImport,
  reversalResultOf,
  reversalView,
  routeKeepReason,
};
