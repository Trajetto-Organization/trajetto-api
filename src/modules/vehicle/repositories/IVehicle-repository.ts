import {
  Vehicle,
  CreateVehicleProps,
  ListVehicleProps,
  ListVehicleByBusinessIdProps,
  UpdateVehicle,
  GetVehicleByIdAndBusinessProps,
  SearchVehicleWithCursorProps,
  CursorPaginatedVehicle,
} from "../dtos/vehicle-dto";

interface IVehicleRepository {
  createVehicle: (vehicleData: CreateVehicleProps) => Promise<Vehicle>;
  listVehicles: (
    listVehicleProps: ListVehicleByBusinessIdProps,
  ) => Promise<ListVehicleProps>;
  updateVehicle: ({
    vehicleData,
    vehicleId,
  }: UpdateVehicle) => Promise<Vehicle>;
  deleteVehicle: (vehicleId: string) => Promise<Vehicle>;
  findVehicleById: (vehicleId: string) => Promise<Vehicle | null>;
  findVehicleByLicensePlate: (licensePlate: string) => Promise<Vehicle | null>;
  findVehicleByRenavam: (renavam: string) => Promise<Vehicle | null>;
  getVehicleByIdAndBusiness({
    businessId,
    vehicleId,
  }: GetVehicleByIdAndBusinessProps): Promise<Vehicle | null>;
  findVehiclesByFuelTypeId: (fuelTypeId: string) => Promise<Vehicle[]>;
  streamVehiclesForExport: (
    businessId: string,
    userRole: string,
    search?: string,
  ) => AsyncGenerator<any>;
  searchVehicleWithCursor: (
    props: SearchVehicleWithCursorProps,
  ) => Promise<CursorPaginatedVehicle>;
  countVehiclesForExport: (
    businessId: string,
    userRole: string,
  ) => Promise<number>;
}

export { IVehicleRepository };
