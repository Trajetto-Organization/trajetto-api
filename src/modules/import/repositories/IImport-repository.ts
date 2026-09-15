import type {
  CreateImportProps,
  ImportRecord,
  ListImportsProps,
  ListImportsResult,
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
  createImport: (data: CreateImportProps) => Promise<ImportRecord>;

  findImportById: (
    importId: string,
    businessId: string,
  ) => Promise<ImportRecord | null>;

  listImports: (props: ListImportsProps) => Promise<ListImportsResult>;

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
   */
  reverseImport: (
    importId: string,
    businessId: string,
  ) => Promise<ReversalResult>;
}

export type { IImportRepository };
