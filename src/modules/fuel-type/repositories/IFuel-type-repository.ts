import {
  FuelType,
  CreateFuelTypeProps,
  ListFuelTypeProps,
  ListFuelTypeByBusinessIdProps,
  UpdateFuelType,
  ListFuelTypeBusinessProps,
} from "../dtos/fuel-type-dto";

interface IFuelTypeRepository {
  createFuelType: (fuelTypeData: CreateFuelTypeProps) => Promise<FuelType>;
  listFuelTypes: (
    listFuelTypeProps: ListFuelTypeByBusinessIdProps,
  ) => Promise<ListFuelTypeProps>;
  listFuelTypeBusiness: ({
    page,
    pageSize,
    businessId,
  }: ListFuelTypeBusinessProps) => Promise<ListFuelTypeProps>;
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
}

export { IFuelTypeRepository };
