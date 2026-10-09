import type { Prisma } from "@prisma/client";

import type {
  RemovedDelivery,
  CreateImportProps,
  FinishImportProps,
  ImportRecord,
  ListImportsProps,
  ListImportsPage,
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
   * Undoes what one upload created, as far as it still can.
   *
   * Removes only what nothing has happened to: a delivery still PENDING with
   * no events and no occurrences, a route still PLANNED. Everything else is
   * kept and reported with the reason — a delivery already proven is a fact
   * about the world, and an undo button must not be able to erase one.
   *
   * One transaction: a half-undone import is worse than one not undone,
   * because nobody can tell which half.
   *
   * `onRemoved` runs inside that transaction with the deliveries actually
   * deleted, so what is announced about them commits with the deletion.
   */
  reverseImport: (
    importId: string,
    businessId: string,
    onRemoved?: (
      removed: RemovedDelivery[],
      tx?: Prisma.TransactionClient,
    ) => Promise<void>,
  ) => Promise<ReversalResult>;
}

export type { IImportRepository };
