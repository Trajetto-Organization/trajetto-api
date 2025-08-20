import {
  Fuel,
  CreateFuelProps,
  ListFuelProps,
  ListFuelFormattedProps,
  ListFuelByBusinessIdProps,
  UpdateFuel,
  ListFuelBusinessProps,
  GetFuelByIdAndBusinessProps,
  FuelWithRelationsFormatted,
} from "../dtos/fuel-dto";

interface IFuelRepository {
  createFuel: (fuelData: CreateFuelProps) => Promise<Fuel>;
  listFuels: (
    listFuelProps: ListFuelByBusinessIdProps,
  ) => Promise<ListFuelFormattedProps>;
  listFuelBusiness: ({
    page,
    pageSize,
    businessId,
  }: ListFuelBusinessProps) => Promise<ListFuelProps>;
  updateFuel: ({ fuelData, fuelId }: UpdateFuel) => Promise<Fuel>;
  deleteFuel: (fuelId: string) => Promise<Fuel>;
  findFuelById: (fuelId: string) => Promise<Fuel | null>;
  findFuelByIdWithRelations: (
    fuelId: string,
  ) => Promise<FuelWithRelationsFormatted | null>;
  getFuelByIdAndBusiness({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<Fuel | null>;
  getFuelByIdAndBusinessWithRelations({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<FuelWithRelationsFormatted | null>;
  findFuelsByVehicleId: (vehicleId: string) => Promise<Fuel[]>;
  findFuelsByDriverId: (driverId: string) => Promise<Fuel[]>;
  findFuelsByFuelTypeId: (fuelTypeId: string) => Promise<Fuel[]>;
  getAllFuelsForExport: (
    businessId: string,
    userRole: string,
    search?: string,
  ) => Promise<any[]>;
}

export { IFuelRepository };
