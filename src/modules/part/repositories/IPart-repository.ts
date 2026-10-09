import {
  Part,
  CreatePartProps,
  ListPartProps,
  ListPartByBusinessIdProps,
  UpdatePart,
  SearchPartWithCursorProps,
  CursorPaginatedPart,
} from "../dtos/part-dto";

interface IPartRepository {
  createPart: (partData: CreatePartProps) => Promise<Part>;
  /** One page of a company's catalog and the counts behind its cards. */
  listParts: (
    listPartProps: ListPartByBusinessIdProps,
  ) => Promise<ListPartProps>;
  searchPartWithCursor: (
    props: SearchPartWithCursorProps,
  ) => Promise<CursorPaginatedPart>;
  updatePart: ({ partData, partId }: UpdatePart) => Promise<Part>;
  deletePart: (partId: string) => Promise<Part>;
  findPartById: (partId: string) => Promise<Part | null>;
  /**
   * Another part of this company with the same description, compared as
   * lower(btrim(...)) — the key of the unique index FLEET-DUP-1 plans.
   * `exceptPartId` leaves the part being edited out, so changing only the
   * case of its own description is not a duplicate of itself.
   */
  findPartByDescription: (
    description: string,
    businessId: string,
    exceptPartId?: string,
  ) => Promise<Part | null>;
  /** How many service order lines use the part. */
  countServiceOrderPartsByPartId: (partId: string) => Promise<number>;
}

export { IPartRepository };
