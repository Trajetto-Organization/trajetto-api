import { Prisma } from "@prisma/client";

import {
  VehicleChecklist,
  CreateVehicleChecklistProps,
  ListVehicleChecklistProps,
  ListVehicleChecklistByBusinessIdProps,
  UpdateVehicleChecklist,
  GetVehicleChecklistByIdAndBusinessProps,
  VehicleChecklistWithRelations,
} from "../dtos/vehicle-checklist-dto";

interface IVehicleChecklistRepository {
  createVehicleChecklist: (
    checklistData: CreateVehicleChecklistProps,
  ) => Promise<VehicleChecklist>;
  createVehicleChecklistWithMileage: (
    checklistData: CreateVehicleChecklistProps,
    afterCreate?: (
      tx: Prisma.TransactionClient,
      checklist: VehicleChecklist,
    ) => Promise<void>,
  ) => Promise<{ checklist: VehicleChecklist; created: boolean }>;
  findBySubmissionId: (
    businessId: string,
    clientSubmissionId: string,
  ) => Promise<VehicleChecklist | null>;
  listVehicleChecklists: (
    listChecklistProps: ListVehicleChecklistByBusinessIdProps,
  ) => Promise<ListVehicleChecklistProps>;
  updateVehicleChecklist: ({
    checklistData,
    checklistId,
  }: UpdateVehicleChecklist) => Promise<VehicleChecklist>;
  updateVehicleChecklistAndMileage: (
    update: UpdateVehicleChecklist,
    mileageUpdate?: {
      businessId: string;
      vehicleId: string;
      currentMileage: number;
    },
  ) => Promise<VehicleChecklist>;
  deleteVehicleChecklist: (checklistId: string) => Promise<VehicleChecklist>;
  findVehicleChecklistById: (
    checklistId: string,
  ) => Promise<VehicleChecklist | null>;
  findVehicleChecklistByIdWithRelations: (
    checklistId: string,
  ) => Promise<VehicleChecklistWithRelations | null>;
  getVehicleChecklistByIdAndBusiness({
    businessId,
    checklistId,
  }: GetVehicleChecklistByIdAndBusinessProps): Promise<VehicleChecklist | null>;
  getVehicleChecklistByIdAndBusinessWithRelations({
    businessId,
    checklistId,
  }: GetVehicleChecklistByIdAndBusinessProps): Promise<VehicleChecklistWithRelations | null>;
  findVehicleChecklistsByVehicleId: (
    vehicleId: string,
  ) => Promise<VehicleChecklist[]>;
  findVehicleChecklistsByDriverId: (
    driverId: string,
  ) => Promise<VehicleChecklist[]>;
  streamChecklistsForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): AsyncGenerator<any>;
  countChecklistForExport: (
    businessId: string,
    userRole: string,
  ) => Promise<number>;
}

export { IVehicleChecklistRepository };
