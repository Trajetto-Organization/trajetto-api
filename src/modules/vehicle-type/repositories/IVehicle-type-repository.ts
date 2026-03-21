import {
  VehicleType,
  CreateVehicleTypeProps,
  ListVehicleTypeProps,
  ListVehicleTypeByBusinessIdProps,
  UpdateVehicleType,
  SearchVehicleTypeWithCursorProps,
  CursorPaginatedVehicleType,
} from "../dtos/vehicle-type-dto";

interface IVehicleTypeRepository {
  createVehicleType: (
    vehicleTypeData: CreateVehicleTypeProps,
  ) => Promise<VehicleType>;
  listVehicleTypes: (
    listVehicleTypeProps: ListVehicleTypeByBusinessIdProps,
  ) => Promise<ListVehicleTypeProps>;
  updateVehicleType: ({
    vehicleTypeData,
    vehicleTypeId,
  }: UpdateVehicleType) => Promise<VehicleType>;
  deleteVehicleType: (vehicleTypeId: string) => Promise<VehicleType>;
  findVehicleTypeById: (vehicleTypeId: string) => Promise<VehicleType | null>;
  findVehicleTypeByIdAndBusiness: (
    vehicleTypeId: string,
    businessId: string,
  ) => Promise<VehicleType | null>;
  findVehicleTypeByDescription: (
    description: string,
    businessId: string,
  ) => Promise<VehicleType | null>;
  searchVehicleTypeWithCursor: (
    props: SearchVehicleTypeWithCursorProps,
  ) => Promise<CursorPaginatedVehicleType>;
}

export { IVehicleTypeRepository };
