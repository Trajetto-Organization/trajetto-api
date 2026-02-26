import {
  VehicleChecklist,
  CreateVehicleChecklistProps,
  ListVehicleChecklistProps,
  ListVehicleChecklistByBusinessIdProps,
  UpdateVehicleChecklist,
  ListVehicleChecklistBusinessProps,
  GetVehicleChecklistByIdAndBusinessProps,
  VehicleChecklistWithRelations,
} from "../dtos/vehicle-checklist-dto";

interface IVehicleChecklistRepository {
  createVehicleChecklist: (
    checklistData: CreateVehicleChecklistProps,
  ) => Promise<VehicleChecklist>;
  listVehicleChecklists: (
    listChecklistProps: ListVehicleChecklistByBusinessIdProps,
  ) => Promise<ListVehicleChecklistProps>;
  listVehicleChecklistBusiness: ({
    page,
    pageSize,
    businessId,
  }: ListVehicleChecklistBusinessProps) => Promise<ListVehicleChecklistProps>;
  updateVehicleChecklist: ({
    checklistData,
    checklistId,
  }: UpdateVehicleChecklist) => Promise<VehicleChecklist>;
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
  getAllVehicleChecklistsForExport: (
    businessId: string,
    userRole: string,
    search?: string,
  ) => Promise<any[]>;
}

export { IVehicleChecklistRepository };
