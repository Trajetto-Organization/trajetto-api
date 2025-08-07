import {
  Part,
  CreatePartProps,
  ListPartProps,
  ListPartByBusinessIdProps,
  UpdatePart,
  ListPartBusinessProps,
} from "../dtos/part-dto";

interface IPartRepository {
  createPart: (partData: CreatePartProps) => Promise<Part>;
  listParts: (
    listPartProps: ListPartByBusinessIdProps,
  ) => Promise<ListPartProps>;
  listPartBusiness: ({
    page,
    pageSize,
    businessId,
  }: ListPartBusinessProps) => Promise<ListPartProps>;
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
