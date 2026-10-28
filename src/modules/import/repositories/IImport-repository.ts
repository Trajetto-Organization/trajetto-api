import type { Prisma } from "@prisma/client";

import type {
  RemovedDelivery,
  CreateImportProps,
  FinishImportProps,
  ImportRecord,
  ListImportsProps,
  ListImportsPage,
  ReversalClaim,
  ReversalProgress,
  ReversalResult,
} from "../dtos/import-dto";

/**
 * Uploads, and the ability to take one back.
 *
 * Every method takes the `businessId` alongside the id and puts it in the
 * `where`, for the same reason the route module does: the use case protects
 * the path somebody remembered, and the `where` protects the ones nobody
 * thought about.
 */
interface IImportRepository {
  /**
   * Opens the upload. IN_PROGRESS until `finishImport` closes it — on
   * success, on a failure the process survives, or by the abandoned-import
   * sweep when it did not.
   */
  createImport: (data: CreateImportProps) => Promise<ImportRecord>;

  /**
   * Closes it with the counts and the report.
   *
   * Scoped by company like everything else here, so a crash in one tenant's
   * import can never write a report onto another's.
   *
   * Only an upload still IN_PROGRESS is closed: one that the abandoned-import
   * sweep already closed, or that was reversed since, is left as it is and
   * returned as it stands.
   */
  finishImport: (
    importId: string,
    businessId: string,
    data: FinishImportProps,
  ) => Promise<ImportRecord>;

  /**
   * The running upload's heartbeat: bumps `updated_at` while it is still
   * IN_PROGRESS. An upload whose heartbeat stopped is one whose process died,
   * and `closeAbandonedImports` tells the two apart by it.
   */
  touchImport: (importId: string, businessId: string) => Promise<void>;

  /**
   * Closes the uploads whose process died mid-way (IDEMP-10).
   *
   * An IN_PROGRESS upload with no heartbeat since `staleBefore` is closed as
   * COMPLETED, with the deliveries it did create counted and one report line
   * saying it stopped — which is what lets the undo, which refuses a RUNNING
   * upload, take it back. Returns how many were closed.
   */
  closeAbandonedImports: (staleBefore: Date, limit?: number) => Promise<number>;

  /**
   * Closes one upload a replica shutting down hands back (import-queue.ts),
   * right away instead of after the sweep's staleness window: the same
   * COMPLETED report the sweep writes, with the deliveries counted from the
   * rows and the line saying it never reached its rows ("not-started": it
   * was waiting or still reading the file, nothing was created) or was
   * stopped in them ("stopped"). Only while IN_PROGRESS; answers whether it
   * closed.
   */
  closeInterruptedImport: (
    importId: string,
    businessId: string,
    stage: "not-started" | "stopped",
  ) => Promise<boolean>;

  findImportById: (
    importId: string,
    businessId: string,
  ) => Promise<ImportRecord | null>;

  /**
   * The page (Status and Origem filters, in the list's order) and the count
   * per status and origin over the whole company.
   */
  listImports: (props: ListImportsProps) => Promise<ListImportsPage>;

  /**
   * Undoes what one upload created, as far as it still can, start to finish
   * in the caller's time: `claimReversal`, then `runReversal`.
   *
   * Removes only what nothing has happened to: a delivery still PENDING with
   * no events and no occurrences, a route still PLANNED. Everything else is
   * kept and reported with the reason — a delivery already proven is a fact
   * about the world, and an undo button must not be able to erase one.
   *
   * Batched (services/import-reversal.ts), and still never "half undone with
   * nobody able to tell which half": the record carries what every committed
   * batch did, stays COMPLETED until the last one, and a retry resumes.
   *
   * Throws ImportAlreadyReversedError for an upload already reversed and
   * ImportReversalRunningError while a live run undoes it; another company's
   * upload, or one still running, touches nothing.
   */
  reverseImport: (
    importId: string,
    businessId: string,
    onRemoved?: ReversalRemovedHook,
  ) => Promise<ReversalResult>;

  /** How many deliveries still carry the upload's id (what an undo has left). */
  countImportDeliveries: (
    importId: string,
    businessId: string,
  ) => Promise<number>;

  /**
   * Takes the undo's lease, by a conditional write: only a COMPLETED upload
   * with no lease, or with one whose heartbeat is older than `staleBefore`
   * (its run died), is claimed. Of two racing, exactly one gets it.
   */
  claimReversal: (
    importId: string,
    businessId: string,
    staleBefore: Date,
  ) => Promise<ReversalClaim>;

  /** The lease's heartbeat while the run waits its turn in the queue. */
  touchReversal: (
    importId: string,
    businessId: string,
    lease: Date,
  ) => Promise<void>;

  /**
   * Drops the undo's lease, if it is still `lease`, keeping the progress: the
   * record reads INTERRUPTED and asking again resumes at once. What a failed
   * run does, and what a replica shutting down does for an undo it will not
   * finish.
   */
  releaseReversal: (
    importId: string,
    businessId: string,
    lease: Date,
  ) => Promise<void>;

  /**
   * Runs a claimed undo to its end: the routes once, then the deliveries
   * `batchSize` at a time in id order, each batch one transaction that
   * re-checks the lease first, removes, announces (`onRemoved`, inside that
   * transaction, with the deliveries actually deleted) and records its
   * progress. The last one flips the upload to REVERSED and drops the lease.
   * A failure drops the lease too, keeping the progress, so a retry resumes
   * at once.
   */
  runReversal: (
    importId: string,
    businessId: string,
    lease: Date,
    progress: ReversalProgress,
    options: { onRemoved?: ReversalRemovedHook; batchSize?: number },
  ) => Promise<ReversalResult>;
}

/** What is announced about the deliveries a batch removed, in its transaction. */
type ReversalRemovedHook = (
  removed: RemovedDelivery[],
  tx?: Prisma.TransactionClient,
) => Promise<void>;

export type { IImportRepository, ReversalRemovedHook };
