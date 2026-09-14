import { v7 as uuidV7 } from "uuid";
import { IVehicleRepository } from "../IVehicle-repository";
import {
  tallyStatuses,
  VEHICLE_STATUSES,
  totalFromStatusCounts,
} from "@/shared/vehicle/vehicle-rules";

import {
  Vehicle,
  CreateVehicleProps,
  ListVehicleProps,
  ListVehicleByBusinessIdProps,
  UpdateVehicle,
  GetVehicleByIdAndBusinessProps,
  SearchVehicleWithCursorProps,
  CursorPaginatedVehicle,
} from "../../dtos/vehicle-dto";

class InMemoryVehicleRepository implements IVehicleRepository {
  public vehicles: Vehicle[] = [];

  async createVehicle(vehicleData: CreateVehicleProps): Promise<Vehicle> {
    const newVehicle: Vehicle = {
      id: uuidV7(),
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

    // Counted over filteredVehicles, NOT over `data` — the same distinction
    // the real repository makes between the fleet and the page on screen.
    const statusCounts = tallyStatuses(
      VEHICLE_STATUSES.map((status) => ({
        status,
        _count: {
          _all: filteredVehicles.filter((v) => v.status === status).length,
        },
      })),
    );

    return {
      data,
      total: totalFromStatusCounts(statusCounts),
      meta: { statusCounts },
    };
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

  async *streamVehiclesForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): AsyncGenerator<any> {
    let filtered =
      userRole === "MASTER"
        ? [...this.vehicles]
        : this.vehicles.filter((vehicle) => vehicle.businessId === businessId);

    if (search) {
      const searchTerm = search.toLowerCase();
      filtered = filtered.filter(
        (vehicle) =>
          vehicle.id.toLowerCase().includes(searchTerm) ||
          vehicle.description.toLowerCase().includes(searchTerm) ||
          vehicle.license_plate.toLowerCase().includes(searchTerm) ||
          vehicle.brand.toLowerCase().includes(searchTerm) ||
          vehicle.model.toLowerCase().includes(searchTerm) ||
          vehicle.renavam.toLowerCase().includes(searchTerm),
      );
    }

    for (const vehicle of filtered) {
      yield {
        id: vehicle.id,
        description: vehicle.description,
        license_plate: vehicle.license_plate,
        brand: vehicle.brand,
        model: vehicle.model,
        acquisition_date: vehicle.acquisition_date,
        fleet_type: vehicle.fleet_type,
        fleet_id: vehicle.fleet_id,
        current_mileage: vehicle.current_mileage,
        last_maintenance_mileage: vehicle.last_maintenance_mileage,
        last_maintenance_date: vehicle.last_maintenance_date,
        maintenance_interval_km: vehicle.maintenance_interval_km,
        maintenance_interval_months: vehicle.maintenance_interval_months,
        renavam: vehicle.renavam,
        manufacturing_year: vehicle.manufacturing_year,
        model_year: vehicle.model_year,
        km_per_liter: vehicle.km_per_liter,
        number_of_axles: vehicle.number_of_axles,
        status: vehicle.status,
        vehicleTypeName: null,
        fuelTypeName: null,
        driverName: null,
        driverCpf: null,
        branchName: null,
        businessId: vehicle.businessId,
        ...(userRole === "MASTER" ? { businessName: null } : {}),
        created_at: vehicle.created_at,
        updated_at: vehicle.updated_at,
      };
    }
  }

  async searchVehicleWithCursor({
    limit = 10,
    cursor,
    businessId,
    driverId,
    search,
  }: SearchVehicleWithCursorProps): Promise<CursorPaginatedVehicle> {
    let filtered = this.vehicles.filter(
      (vehicle) =>
        vehicle.businessId === businessId &&
        (!driverId || vehicle.driverId === driverId) &&
        ["ACTIVE", "IN_ROUTE"].includes(vehicle.status),
    );

    if (search) {
      const term = search.toLowerCase();
      filtered = filtered.filter((vehicle) =>
        [
          vehicle.description,
          vehicle.license_plate,
          vehicle.brand,
          vehicle.model,
          vehicle.renavam,
        ].some((value) => value.toLowerCase().includes(term)),
      );
    }

    if (cursor) {
      const cursorIndex = filtered.findIndex((v) => v.id === cursor);
      if (cursorIndex !== -1) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countVehiclesForExport(
    businessId: string,
    userRole: string,
  ): Promise<number> {
    const filteredVehicles =
      userRole === "MASTER"
        ? this.vehicles
        : this.vehicles.filter((vehicle) => vehicle.businessId === businessId);

    return filteredVehicles.length;
  }

  async countActiveVehiclesByBusinessId(businessId: string): Promise<number> {
    return this.vehicles.filter(
      (vehicle) =>
        vehicle.businessId === businessId && vehicle.status !== "INACTIVE",
    ).length;
  }

  async countInactiveVehiclesByBusinessId(businessId: string): Promise<number> {
    return this.vehicles.filter(
      (vehicle) =>
        vehicle.businessId === businessId && vehicle.status === "INACTIVE",
    ).length;
  }
}

export { InMemoryVehicleRepository };
