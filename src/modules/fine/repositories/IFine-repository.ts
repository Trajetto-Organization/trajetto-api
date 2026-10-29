import { Prisma } from "@prisma/client";

import {
  Fine,
  NewFine,
  FineExportRow,
  FineListQuery,
  ListFinesQuery,
  ListFinesResult,
  UpdateFine,
} from "../dtos/fine-dto";

interface IFineRepository {
  createFine: (
    fineData: NewFine,
    tx?: Prisma.TransactionClient,
  ) => Promise<Fine>;
  /** The fine a web submission already created, within this company. */
  findFineBySubmissionId: (
    businessId: string,
    clientSubmissionId: string,
  ) => Promise<Fine | null>;
  /** One page of one company, plus the groups the cards and filters come from. */
  listFines: (query: ListFinesQuery) => Promise<ListFinesResult>;
  /** Every fine the list would show, in the list's order (decision 5.8). */
  streamFinesForExport(query: FineListQuery): AsyncGenerator<FineExportRow>;
  countFinesForExport: (query: FineListQuery) => Promise<number>;
  /** `businessId` in the `where`, like the delete: a foreign fine is not updated. */
  updateFine: ({ fineData, fineId, businessId }: UpdateFine) => Promise<Fine>;
  /** `businessId` in the `where`, always: the second lock of the tenant rule. */
  deleteFine: (fineId: string, businessId: string) => Promise<Fine>;
  findFineById: (fineId: string) => Promise<Fine | null>;
  /**
   * How many fines name the driver: the driver delete guard needs the number,
   * not the rows. (The vehicle guard counts through its own repository.)
   */
  countFinesByDriverId: (driverId: string) => Promise<number>;
}

export { IFineRepository };
