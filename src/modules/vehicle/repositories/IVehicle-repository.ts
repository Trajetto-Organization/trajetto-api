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

  // Analytics methods
  countVehiclesByStatus: (
    businessId: string,
  ) => Promise<{
    totalVehicles: number;
    activeVehicles: number;
    inactiveVehicles: number;
    blockedVehicles: number;
    inRouteVehicles: number;
  }>;
  getVehicleUtilizationData: (
    businessId: string,
    startDate: Date,
    endDate: Date,
  ) => Promise<
    Array<{
      vehicleId: string;
      vehiclePlate: string;
      totalRoutes: number;
      totalDistance: number;
    }>
  >;
}

export { IVehicleRepository };
