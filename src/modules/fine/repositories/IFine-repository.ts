import { Prisma } from "@prisma/client";

import {
  Fine,
  CreateFineProps,
  ListFineProps,
  ListFineByBusinessIdProps,
  UpdateFine,
} from "../dtos/fine-dto";

interface IFineRepository {
  createFine: (
    fineData: CreateFineProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<Fine>;
  listFines: (
    listFineProps: ListFineByBusinessIdProps,
  ) => Promise<ListFineProps>;
  streamFinesForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): AsyncGenerator<any>;
  countFinesForExport: (
    businessId: string,
    userRole: string,
  ) => Promise<number>;
  updateFine: ({ fineData, fineId }: UpdateFine) => Promise<Fine>;
  deleteFine: (fineId: string) => Promise<Fine>;
  findFineById: (fineId: string) => Promise<Fine | null>;
  findFinesByDriverId: (driverId: string) => Promise<Fine[]>;
  findFinesByVehicleId: (vehicleId: string) => Promise<Fine[]>;
  getFinesByDateRange: (
    businessId: string,
    startDate: Date,
    endDate: Date,
  ) => Promise<Fine[]>;
}

export { IFineRepository };
