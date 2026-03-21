import { v7 as uuidV7 } from "uuid";
import { IVehicleTypeRepository } from "../IVehicle-type-repository";

import {
  VehicleType,
  CreateVehicleTypeProps,
  ListVehicleTypeProps,
  ListVehicleTypeByBusinessIdProps,
  UpdateVehicleType,
  SearchVehicleTypeWithCursorProps,
  CursorPaginatedVehicleType,
} from "../../dtos/vehicle-type-dto";

class InMemoryVehicleTypeRepository implements IVehicleTypeRepository {
  public vehicleTypes: VehicleType[] = [];

  async createVehicleType(
    vehicleTypeData: CreateVehicleTypeProps,
  ): Promise<VehicleType> {
    const newVehicleType: VehicleType = {
      id: uuidV7(),
      description: vehicleTypeData.description,
      number_of_axles: vehicleTypeData.number_of_axles,
      businessId: vehicleTypeData.businessId,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.vehicleTypes.push(newVehicleType);
    return newVehicleType;
  }

  async listVehicleTypes({
    page,
    pageSize,
    businessId,
    search,
  }: ListVehicleTypeByBusinessIdProps): Promise<ListVehicleTypeProps> {
    let filteredVehicleTypes = this.vehicleTypes.filter(
      (vehicleType) => vehicleType.businessId === businessId,
    );

    if (search) {
      const searchTerm = search.toLowerCase();
      filteredVehicleTypes = filteredVehicleTypes.filter((vehicleType) =>
        vehicleType.description.toLowerCase().includes(searchTerm),
      );
    }

    const skip = (page - 1) * pageSize;
    const data = filteredVehicleTypes.slice(skip, skip + pageSize);

    const total = filteredVehicleTypes.length;
    return { data, total };
  }

  async updateVehicleType({
    vehicleTypeData,
    vehicleTypeId,
  }: UpdateVehicleType): Promise<VehicleType> {
    const index = this.vehicleTypes.findIndex(
      (vehicleType) => vehicleType.id === vehicleTypeId,
    );

    if (index === -1) {
      throw new Error("Vehicle type not found");
    }

    const filteredData = Object.fromEntries(
      Object.entries(vehicleTypeData).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    const updatedVehicleType: VehicleType = {
      ...this.vehicleTypes[index],
      ...filteredData,
      updated_at: new Date(),
    };

    this.vehicleTypes[index] = updatedVehicleType;
    return updatedVehicleType;
  }

  async deleteVehicleType(vehicleTypeId: string): Promise<VehicleType> {
    const index = this.vehicleTypes.findIndex(
      (vehicleType) => vehicleType.id === vehicleTypeId,
    );

    if (index === -1) {
      throw new Error("Vehicle type not found");
    }

    const deletedVehicleType = this.vehicleTypes.splice(index, 1)[0];
    return deletedVehicleType;
  }

  async findVehicleTypeById(
    vehicleTypeId: string,
  ): Promise<VehicleType | null> {
    const vehicleType = this.vehicleTypes.find(
      (vehicleType) => vehicleType.id === vehicleTypeId,
    );

    return vehicleType || null;
  }

  async findVehicleTypeByIdAndBusiness(
    vehicleTypeId: string,
    businessId: string,
  ): Promise<VehicleType | null> {
    const vehicleType = this.vehicleTypes.find(
      (vehicleType) =>
        vehicleType.id === vehicleTypeId &&
        vehicleType.businessId === businessId,
    );

    return vehicleType || null;
  }

  async findVehicleTypeByDescription(
    description: string,
    businessId: string,
  ): Promise<VehicleType | null> {
    const vehicleType = this.vehicleTypes.find(
      (vehicleType) =>
        vehicleType.description === description &&
        vehicleType.businessId === businessId,
    );

    return vehicleType || null;
  }
  async searchVehicleTypeWithCursor({
    limit = 10,
    cursor,
    businessId,
  }: SearchVehicleTypeWithCursorProps): Promise<CursorPaginatedVehicleType> {
    let filtered = this.vehicleTypes.filter(
      (vt) => vt.businessId === businessId,
    );

    if (cursor) {
      const cursorIndex = filtered.findIndex((vt) => vt.id === cursor);
      if (cursorIndex !== -1) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }
}

export { InMemoryVehicleTypeRepository };
