import {
  Fuel,
  CreateFuelProps,
  ListFuelProps,
  ListFuelByBusinessIdProps,
  UpdateFuel,
  ListFuelBusinessProps,
  GetFuelByIdAndBusinessProps,
  ListFuelByVehicleIdProps,
} from "../dtos/fuel-dto";

interface IFuelRepository {
  createFuel: (fuelData: CreateFuelProps) => Promise<Fuel>;
  listFuels: (
    listFuelProps: ListFuelByBusinessIdProps,
  ) => Promise<ListFuelProps>;
  listFuelBusiness: ({
    page,
    pageSize,
    businessId,
  }: ListFuelBusinessProps) => Promise<ListFuelProps>;
  updateFuel: ({ fuelData, fuelId }: UpdateFuel) => Promise<Fuel>;
  deleteFuel: (fuelId: string) => Promise<Fuel>;
  findFuelById: (fuelId: string) => Promise<Fuel | null>;
  findFuelByIdWithRelations: (fuelId: string) => Promise<any | null>;
  getFuelByIdAndBusiness({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<Fuel | null>;
  getFuelByIdAndBusinessWithRelations({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<any | null>;
  findFuelsByVehicleId: (vehicleId: string) => Promise<Fuel[]>;
  findFuelsByDriverId: (driverId: string) => Promise<Fuel[]>;
  findFuelsByFuelTypeId: (fuelTypeId: string) => Promise<Fuel[]>;
  getAllFuelsForExport: (
    businessId: string,
    userRole: string,
    search?: string,
  ) => Promise<any[]>;
  getPreviousFuelByVehicleId: (
    vehicleId: string,
    currentFuelDate: Date | string,
  ) => Promise<Fuel | null>;
  listFuelsByVehicleId: (
    listFuelProps: ListFuelByVehicleIdProps,
  ) => Promise<ListFuelProps>;
}

export { IFuelRepository };
