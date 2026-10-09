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
  /** One company's page, sorted by the server, with each type's vehicle count. */
  listVehicleTypes: (
    listVehicleTypeProps: ListVehicleTypeByBusinessIdProps,
  ) => Promise<ListVehicleTypeProps>;
  /** Writes only what is not `undefined`; `null` clears a nullable column. */
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
  /**
   * Vehicles registered with this type. The foreign key is SET NULL, so a
   * delete would silently strip the type from all of them (FLEET-VTYPE-2).
   */
  countVehiclesUsingType: (vehicleTypeId: string) => Promise<number>;
}

export { IVehicleTypeRepository };
