import {
  Fuel,
  CreateFuelProps,
  ListFuelProps,
  ListFuelByBusinessIdProps,
  UpdateFuel,
  ListFuelBusinessProps,
  GetFuelByIdAndBusinessProps,
  FuelWithRelations,
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
  updateFuel: ({
    fuelData,
    fuelId,
  }: UpdateFuel) => Promise<Fuel>;
  deleteFuel: (fuelId: string) => Promise<Fuel>;
  findFuelById: (fuelId: string) => Promise<Fuel | null>;
  findFuelByIdWithRelations: (fuelId: string) => Promise<FuelWithRelations | null>;
  getFuelByIdAndBusiness({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<Fuel | null>;
  getFuelByIdAndBusinessWithRelations({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<FuelWithRelations | null>;
}

export { IFuelRepository };