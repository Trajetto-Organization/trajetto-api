import {
  FuelType,
  CreateFuelTypeProps,
  ListFuelTypeProps,
  ListFuelTypeByBusinessIdProps,
  UpdateFuelType,
  SearchFuelTypeWithCursorProps,
  CursorPaginatedFuelType,
  FuelTypeUsage,
} from "../dtos/fuel-type-dto";

interface IFuelTypeRepository {
  createFuelType: (fuelTypeData: CreateFuelTypeProps) => Promise<FuelType>;
  listFuelTypes: (
    listFuelTypeProps: ListFuelTypeByBusinessIdProps,
  ) => Promise<ListFuelTypeProps>;
  updateFuelType: ({
    fuelTypeData,
    fuelTypeId,
  }: UpdateFuelType) => Promise<FuelType>;
  deleteFuelType: (fuelTypeId: string) => Promise<FuelType>;
  findFuelTypeById: (fuelTypeId: string) => Promise<FuelType | null>;
  findFuelTypeByIdAndBusiness: (
    fuelTypeId: string,
    businessId: string,
  ) => Promise<FuelType | null>;
  findFuelTypeByDescription: (
    description: string,
    businessId: string,
  ) => Promise<FuelType | null>;
  searchFuelTypeWithCursor: (
    props: SearchFuelTypeWithCursorProps,
  ) => Promise<CursorPaginatedFuelType>;
  /** Vehicles and refuelings pointing at the fuel type, counted in one read. */
  countFuelTypeUsage: (fuelTypeId: string) => Promise<FuelTypeUsage>;
}

export { IFuelTypeRepository };
