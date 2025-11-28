import {
  Vehicle,
  CreateVehicleProps,
  ListVehicleProps,
  ListVehicleByBusinessIdProps,
  UpdateVehicle,
  ListVehicleBusinessProps,
  GetVehicleByIdAndBusinessProps,
} from "../dtos/vehicle-dto";

interface IVehicleRepository {
  createVehicle: (vehicleData: CreateVehicleProps) => Promise<Vehicle>;
  listVehicles: (
    listVehicleProps: ListVehicleByBusinessIdProps,
  ) => Promise<ListVehicleProps>;
  listVehicleBusiness: ({
    page,
    pageSize,
    businessId,
  }: ListVehicleBusinessProps) => Promise<ListVehicleProps>;
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
}

export { IVehicleRepository };
