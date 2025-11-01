import { v4 as uuidV4 } from "uuid";

import { IVehicleRepository } from "../IVehicle-repository";
import {
  Vehicle,
  CreateVehicleProps,
  ListVehicleProps,
  ListVehicleByBusinessIdProps,
  UpdateVehicle,
  ListVehicleBusinessProps,
  GetVehicleByIdAndBusinessProps,
} from "../../dtos/vehicle-dto";

class InMemoryVehicleRepository implements IVehicleRepository {
  public vehicles: Vehicle[] = [];

  async createVehicle(vehicleData: CreateVehicleProps): Promise<Vehicle> {
    const newVehicle: Vehicle = {
      id: uuidV4(),
      ...vehicleData,
      fleet_id: vehicleData.fleet_id || null,
      last_maintenance_date: vehicleData.last_maintenance_date || null,
      last_maintenance_mileage: vehicleData.last_maintenance_mileage || null,
      vehicleTypeId: vehicleData.vehicleTypeId || null,
      driverId: vehicleData.driverId || null,
      branchId: vehicleData.branchId || null,
      manufacturing_year:
        typeof vehicleData.manufacturing_year === "string"
          ? new Date(vehicleData.manufacturing_year)
          : vehicleData.manufacturing_year,
      model_year:
        typeof vehicleData.model_year === "string"
          ? new Date(vehicleData.model_year)
          : vehicleData.model_year,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.vehicles.push(newVehicle);
    return newVehicle;
  }

  async listVehicles({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
  }: ListVehicleByBusinessIdProps): Promise<ListVehicleProps> {
    let filteredVehicles =
      currentUserRole === "MASTER"
        ? this.vehicles
        : this.vehicles.filter((vehicle) => vehicle.businessId === businessId);

    if (search) {
      const normalizedSearch = search.trim().toLowerCase();
      filteredVehicles = filteredVehicles.filter(
        (vehicle) =>
          vehicle.id.toLowerCase().includes(normalizedSearch) ||
          vehicle.description.toLowerCase().includes(normalizedSearch) ||
          vehicle.license_plate.toLowerCase().includes(normalizedSearch) ||
          vehicle.brand.toLowerCase().includes(normalizedSearch) ||
          vehicle.model.toLowerCase().includes(normalizedSearch) ||
          vehicle.renavam.toLowerCase().includes(normalizedSearch),
      );
    }

    const skip = (page - 1) * pageSize;
    const data = filteredVehicles.slice(skip, skip + pageSize);

    const total = filteredVehicles.length;
    return { data, total };
  }

  async listVehicleBusiness({
    page,
    pageSize,
    businessId,
    search,
    driverId,
  }: ListVehicleBusinessProps): Promise<ListVehicleProps> {
    let filteredVehicles = this.vehicles.filter(
      (vehicle) => vehicle.businessId === businessId,
    );

    if (driverId) {
      filteredVehicles = filteredVehicles.filter(
        (vehicle) => vehicle.driverId === driverId,
      );
    }

    if (search) {
      const searchLower = search.toLowerCase();
      filteredVehicles = filteredVehicles.filter(
        (vehicle) =>
          vehicle.description.toLowerCase().includes(searchLower) ||
          vehicle.license_plate.toLowerCase().includes(searchLower) ||
          vehicle.model.toLowerCase().includes(searchLower) ||
          vehicle.brand.toLowerCase().includes(searchLower),
      );
    }

    const skip = (page - 1) * pageSize;
    const data = filteredVehicles.slice(skip, skip + pageSize);

    const total = filteredVehicles.length;
    return { data, total };
  }

  async updateVehicle({
    vehicleData,
    vehicleId,
  }: UpdateVehicle): Promise<Vehicle> {
    const index = this.vehicles.findIndex(
      (vehicle) => vehicle.id === vehicleId,
    );

    if (index === -1) {
      throw new Error("Vehicle not found");
    }

    const filteredData = Object.fromEntries(
      Object.entries(vehicleData).filter(([, value]) => value !== undefined),
    );

    // Handle date conversions if needed
    const processedData = { ...filteredData };
    if (processedData.manufacturing_year) {
      processedData.manufacturing_year =
        typeof processedData.manufacturing_year === "string"
          ? new Date(processedData.manufacturing_year)
          : processedData.manufacturing_year;
    }
    if (processedData.model_year) {
      processedData.model_year =
        typeof processedData.model_year === "string"
          ? new Date(processedData.model_year)
          : processedData.model_year;
    }

    const updatedVehicle: Vehicle = {
      ...this.vehicles[index],
      ...processedData,
      updated_at: new Date(),
    };

    this.vehicles[index] = updatedVehicle;
    return updatedVehicle;
  }

  async deleteVehicle(vehicleId: string): Promise<Vehicle> {
    const index = this.vehicles.findIndex(
      (vehicle) => vehicle.id === vehicleId,
    );

    if (index === -1) {
      throw new Error("Vehicle not found");
    }

    const deletedVehicle = this.vehicles.splice(index, 1)[0];
    return deletedVehicle;
  }

  async findVehicleById(vehicleId: string): Promise<Vehicle | null> {
    const found = this.vehicles.find((vehicle) => vehicle.id === vehicleId);
    return found || null;
  }

  async findVehicleByLicensePlate(
    licensePlate: string,
  ): Promise<Vehicle | null> {
    const found = this.vehicles.find(
      (vehicle) =>
        vehicle.license_plate.toLowerCase() === licensePlate.toLowerCase(),
    );
    return found || null;
  }

  async findVehicleByRenavam(renavam: string): Promise<Vehicle | null> {
    const found = this.vehicles.find(
      (vehicle) => vehicle.renavam.toLowerCase() === renavam.toLowerCase(),
    );
    return found || null;
  }

  async getVehicleByIdAndBusiness({
    businessId,
    vehicleId,
  }: GetVehicleByIdAndBusinessProps): Promise<Vehicle | null> {
    const found = this.vehicles.find(
      (vehicle) =>
        vehicle.id === vehicleId && vehicle.businessId === businessId,
    );
    return found || null;
  }

  async findVehiclesByFuelTypeId(fuelTypeId: string): Promise<Vehicle[]> {
    return this.vehicles.filter((vehicle) => vehicle.fuelTypeId === fuelTypeId);
  }
}

export { InMemoryVehicleRepository };
