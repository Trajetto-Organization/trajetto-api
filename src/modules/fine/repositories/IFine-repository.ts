import {
  Fine,
  CreateFineProps,
  ListFineProps,
  ListFineByBusinessIdProps,
  UpdateFine,
} from "../dtos/fine-dto";
import { FineWithLocation } from "@/modules/heatmap/dtos/heatmap-dto";

interface IFineRepository {
  createFine: (fineData: CreateFineProps) => Promise<Fine>;
  listFines: (
    listFineProps: ListFineByBusinessIdProps,
  ) => Promise<ListFineProps>;
  getAllFinesForExport: (
    businessId: string,
    currentUserRole: string,
    search?: string,
  ) => Promise<Fine[]>;
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
  getFinesWithLocation: (
    businessId: string,
    startDate: Date,
    endDate: Date,
    vehicleId?: string,
  ) => Promise<FineWithLocation[]>;
}

export { IFineRepository };
