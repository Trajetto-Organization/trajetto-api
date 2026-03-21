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
  listParts: (
    listPartProps: ListPartByBusinessIdProps,
  ) => Promise<ListPartProps>;
  searchPartWithCursor: (
    props: SearchPartWithCursorProps,
  ) => Promise<CursorPaginatedPart>;
  updatePart: ({ partData, partId }: UpdatePart) => Promise<Part>;
  deletePart: (partId: string) => Promise<Part>;
  findPartById: (partId: string) => Promise<Part | null>;
  findPartByDescription: (
    description: string,
    businessId: string,
  ) => Promise<Part | null>;
  findServiceOrderPartsByPartId: (partId: string) => Promise<Part[]>;
}

export { IPartRepository };
