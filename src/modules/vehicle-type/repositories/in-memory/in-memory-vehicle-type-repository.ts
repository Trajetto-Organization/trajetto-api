import { v4 as uuidV4 } from "uuid";

import { IVehicleTypeRepository } from "../IVehicle-type-repository";
import {
  VehicleType,
  CreateVehicleTypeProps,
  ListVehicleTypeProps,
  ListVehicleTypeByBusinessIdProps,
  UpdateVehicleType,
  ListVehicleTypeBusinessProps,
} from "../../dtos/vehicle-type-dto";

class InMemoryVehicleTypeRepository implements IVehicleTypeRepository {
  public vehicleTypes: VehicleType[] = [];

  async createVehicleType(
    vehicleTypeData: CreateVehicleTypeProps,
  ): Promise<VehicleType> {
    const newVehicleType: VehicleType = {
      id: uuidV4(),
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

  async listVehicleTypeBusiness({
    page,
    pageSize,
    businessId,
  }: ListVehicleTypeBusinessProps): Promise<ListVehicleTypeProps> {
    const filteredVehicleTypes = this.vehicleTypes.filter(
      (vehicleType) => vehicleType.businessId === businessId,
    );

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
}

export { InMemoryVehicleTypeRepository };
