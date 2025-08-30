import { v4 as uuidV4 } from "uuid";

import { IFuelTypeRepository } from "../IFuel-type-repository";
import {
  FuelType,
  CreateFuelTypeProps,
  ListFuelTypeProps,
  ListFuelTypeByBusinessIdProps,
  UpdateFuelType,
  ListFuelTypeBusinessProps,
} from "../../dtos/fuel-type-dto";

class InMemoryFuelTypeRepository implements IFuelTypeRepository {
  public fuelTypes: FuelType[] = [];

  async createFuelType(fuelTypeData: CreateFuelTypeProps): Promise<FuelType> {
    const newFuelType: FuelType = {
      id: uuidV4(),
      description: fuelTypeData.description,
      businessId: fuelTypeData.businessId,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.fuelTypes.push(newFuelType);
    return newFuelType;
  }

  async listFuelTypes({
    page,
    pageSize,
    businessId,
    search,
    currentUserRole,
  }: ListFuelTypeByBusinessIdProps): Promise<ListFuelTypeProps> {
    let filteredFuelTypes = this.fuelTypes;

    // If not MASTER user, filter by business
    if (currentUserRole !== "MASTER" && businessId) {
      filteredFuelTypes = this.fuelTypes.filter(
        (fuelType) => fuelType.businessId === businessId,
      );
    }

    if (search) {
      const searchTerm = search.toLowerCase();
      filteredFuelTypes = filteredFuelTypes.filter((fuelType) =>
        fuelType.description.toLowerCase().includes(searchTerm),
      );
    }

    const skip = (page - 1) * pageSize;

    const data = filteredFuelTypes.slice(skip, skip + pageSize);
    const total = filteredFuelTypes.length;

    return { data, total };
  }

  async listFuelTypeBusiness({
    page,
    pageSize,
    businessId,
  }: ListFuelTypeBusinessProps): Promise<ListFuelTypeProps> {
    const filteredFuelTypes = this.fuelTypes.filter(
      (fuelType) => fuelType.businessId === businessId,
    );

    const skip = (page - 1) * pageSize;

    const data = filteredFuelTypes.slice(skip, skip + pageSize);
    const total = filteredFuelTypes.length;

    return { data, total };
  }

  async updateFuelType({
    fuelTypeData,
    fuelTypeId,
  }: UpdateFuelType): Promise<FuelType> {
    const index = this.fuelTypes.findIndex(
      (fuelType) => fuelType.id === fuelTypeId,
    );

    if (index === -1) {
      throw new Error("Fuel type not found");
    }

    const filteredData = Object.fromEntries(
      Object.entries(fuelTypeData).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    const updatedFuelType: FuelType = {
      ...this.fuelTypes[index],
      ...filteredData,
      updated_at: new Date(),
    };

    this.fuelTypes[index] = updatedFuelType;
    return updatedFuelType;
  }

  async deleteFuelType(fuelTypeId: string): Promise<FuelType> {
    const index = this.fuelTypes.findIndex(
      (fuelType) => fuelType.id === fuelTypeId,
    );

    if (index === -1) {
      throw new Error("Fuel type not found");
    }

    const deletedFuelType = this.fuelTypes.splice(index, 1)[0];
    return deletedFuelType;
  }

  async findFuelTypeById(fuelTypeId: string): Promise<FuelType | null> {
    const fuelType = this.fuelTypes.find(
      (fuelType) => fuelType.id === fuelTypeId,
    );

    return fuelType || null;
  }

  async findFuelTypeByIdAndBusiness(
    fuelTypeId: string,
    businessId: string,
  ): Promise<FuelType | null> {
    const fuelType = this.fuelTypes.find(
      (fuelType) =>
        fuelType.id === fuelTypeId && fuelType.businessId === businessId,
    );

    return fuelType || null;
  }

  async findFuelTypeByDescription(
    description: string,
    businessId: string,
  ): Promise<FuelType | null> {
    const fuelType = this.fuelTypes.find(
      (fuelType) =>
        fuelType.description === description &&
        fuelType.businessId === businessId,
    );

    return fuelType || null;
  }
}

export { InMemoryFuelTypeRepository };
