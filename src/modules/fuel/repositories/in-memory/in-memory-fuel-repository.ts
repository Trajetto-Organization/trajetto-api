import { v4 as uuidV4 } from "uuid";

import { Decimal } from "@prisma/client/runtime/library";
import { IFuelRepository } from "../IFuel-repository";

import {
  Fuel,
  CreateFuelProps,
  ListFuelProps,
  ListFuelByBusinessIdProps,
  UpdateFuel,
  ListFuelBusinessProps,
  GetFuelByIdAndBusinessProps,
  ListFuelByVehicleIdProps,
} from "../../dtos/fuel-dto";

class InMemoryFuelRepository implements IFuelRepository {
  public fuels: Fuel[] = [];

  async createFuel(fuelData: CreateFuelProps): Promise<Fuel> {
    const newFuel: Fuel = {
      id: uuidV4(),
      current_mileage: fuelData.current_mileage,
      liters_amount: new Decimal(fuelData.liters_amount.toString()),
      price_per_liter: new Decimal(fuelData.price_per_liter.toString()),
      total_amount: fuelData.total_amount
        ? new Decimal(fuelData.total_amount.toString())
        : new Decimal(
            Number(fuelData.liters_amount) * Number(fuelData.price_per_liter),
          ),
      odometer_photo: fuelData.odometer_photo || null,
      odometer_verified: fuelData.odometer_verified || false,
      notes: fuelData.notes || null,
      refueling_date: fuelData.refueling_date,
      businessId: fuelData.businessId,
      branchId: fuelData.branchId as string,
      vehicleId: fuelData.vehicleId,
      driverId: fuelData.driverId as string,
      fuelTypeId: fuelData.fuelTypeId,
      // Geolocation fields
      latitude: fuelData.latitude || null,
      longitude: fuelData.longitude || null,
      latitude_original: fuelData.latitude_original || null,
      longitude_original: fuelData.longitude_original || null,
      location_source: fuelData.location_source || null,
      created_from: fuelData.created_from,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.fuels.push(newFuel);
    return newFuel;
  }

  async listFuels({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
    vehicleId,
    driverId,
    fuelTypeId,
    startDate,
    endDate,
  }: ListFuelByBusinessIdProps): Promise<ListFuelProps> {
    let filteredFuels =
      currentUserRole === "MASTER"
        ? [...this.fuels]
        : this.fuels.filter((fuel) => fuel.businessId === businessId);

    if (vehicleId) {
      filteredFuels = filteredFuels.filter(
        (fuel) => fuel.vehicleId === vehicleId,
      );
    }

    if (driverId) {
      filteredFuels = filteredFuels.filter(
        (fuel) => fuel.driverId === driverId,
      );
    }

    if (fuelTypeId) {
      filteredFuels = filteredFuels.filter(
        (fuel) => fuel.fuelTypeId === fuelTypeId,
      );
    }

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);

      filteredFuels = filteredFuels.filter((fuel) => {
        const fuelDate = new Date(fuel.refueling_date);
        return fuelDate >= start && fuelDate <= end;
      });
    }

    if (search) {
      const searchTerm = search.toLowerCase();
      filteredFuels = filteredFuels.filter(
        (fuel) =>
          fuel.id.toLowerCase().includes(searchTerm) ||
          fuel.notes?.toLowerCase().includes(searchTerm) ||
          fuel.current_mileage.toString().includes(searchTerm),
      );
    }

    const skip = (page - 1) * pageSize;

    const data = filteredFuels.slice(skip, skip + pageSize) as any[];
    const total = filteredFuels.length;

    return { data, total };
  }

  async listFuelBusiness({
    page,
    pageSize,
    businessId,
  }: ListFuelBusinessProps): Promise<ListFuelProps> {
    const filteredFuels = this.fuels.filter(
      (fuel) => fuel.businessId === businessId,
    );

    const skip = (page - 1) * pageSize;
    const data = filteredFuels.slice(skip, skip + pageSize);
    const total = filteredFuels.length;

    return { data, total };
  }

  async updateFuel({ fuelData, fuelId }: UpdateFuel): Promise<Fuel> {
    const index = this.fuels.findIndex((fuel) => fuel.id === fuelId);

    if (index === -1) {
      throw new Error("Fuel not found");
    }

    const filteredData = Object.fromEntries(
      Object.entries(fuelData).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    // Convert Decimal fields if they exist in the update
    const processedData = { ...filteredData };
    if (processedData.liters_amount) {
      processedData.liters_amount = new Decimal(
        processedData.liters_amount.toString(),
      );
    }
    if (processedData.price_per_liter) {
      processedData.price_per_liter = new Decimal(
        processedData.price_per_liter.toString(),
      );
    }
    if (processedData.total_amount) {
      processedData.total_amount = new Decimal(
        processedData.total_amount.toString(),
      );
    }

    const updatedFuel: Fuel = {
      ...this.fuels[index],
      ...processedData,
      updated_at: new Date(),
    };

    this.fuels[index] = updatedFuel;
    return updatedFuel;
  }

  async deleteFuel(fuelId: string): Promise<Fuel> {
    const index = this.fuels.findIndex((fuel) => fuel.id === fuelId);

    if (index === -1) {
      throw new Error("Fuel not found");
    }

    const deletedFuel = this.fuels.splice(index, 1)[0];
    return deletedFuel;
  }

  async findFuelById(fuelId: string): Promise<Fuel | null> {
    const found = this.fuels.find((fuel) => fuel.id === fuelId);
    return found || null;
  }

  async findFuelByIdWithRelations(fuelId: string): Promise<any | null> {
    const fuel = this.fuels.find((fuel) => fuel.id === fuelId);

    if (!fuel) {
      return null;
    }

    // Mock relations data for testing (raw data, same as Prisma includes)
    return {
      ...fuel,
      business: {
        id: fuel.businessId,
        corporate_reason: `Business ${fuel.businessId}`,
        fantasy_name: `Fantasy Business ${fuel.businessId}`,
      },
      branch: {
        id: fuel.branchId,
        corporate_reason: `Branch ${fuel.branchId}`,
        fantasy_name: `Fantasy Branch ${fuel.branchId}`,
      },
      vehicle: {
        id: fuel.vehicleId,
        description: `Vehicle ${fuel.vehicleId}`,
        license_plate: `ABC-${fuel.vehicleId.substring(0, 4)}`,
        brand: "Test Brand",
        model: "Test Model",
        current_mileage: fuel.current_mileage,
      },
      driver: {
        id: fuel.driverId,
        name: `Driver ${fuel.driverId}`,
        cnh: `CNH-${fuel.driverId.substring(0, 8)}`,
      },
      fuelType: {
        id: fuel.fuelTypeId,
        description: `Fuel Type ${fuel.fuelTypeId}`,
      },
    };
  }

  async getFuelByIdAndBusiness({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<Fuel | null> {
    const found = this.fuels.find(
      (fuel) => fuel.id === fuelId && fuel.businessId === businessId,
    );
    return found || null;
  }

  async getFuelByIdAndBusinessWithRelations({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<any | null> {
    const fuel = this.fuels.find(
      (fuel) => fuel.id === fuelId && fuel.businessId === businessId,
    );

    if (!fuel) {
      return null;
    }

    return this.findFuelByIdWithRelations(fuelId);
  }

  async findFuelsByVehicleId(vehicleId: string): Promise<Fuel[]> {
    return this.fuels.filter((fuel) => fuel.vehicleId === vehicleId);
  }

  async findFuelsByDriverId(driverId: string): Promise<Fuel[]> {
    return this.fuels.filter((fuel) => fuel.driverId === driverId);
  }

  async findFuelsByFuelTypeId(fuelTypeId: string): Promise<Fuel[]> {
    return this.fuels.filter((fuel) => fuel.fuelTypeId === fuelTypeId);
  }

  async getAllFuelsForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): Promise<any[]> {
    let filteredFuels =
      userRole === "MASTER"
        ? [...this.fuels]
        : this.fuels.filter((fuel) => fuel.businessId === businessId);

    if (search) {
      const searchTerm = search.toLowerCase();
      filteredFuels = filteredFuels.filter(
        (fuel) =>
          fuel.id.toLowerCase().includes(searchTerm) ||
          fuel.notes?.toLowerCase().includes(searchTerm) ||
          fuel.current_mileage.toString().includes(searchTerm),
      );
    }

    return filteredFuels;
  }

  async findFuelsByBusinessId(businessId: string): Promise<Fuel[]> {
    return this.fuels.filter((fuel) => fuel.businessId === businessId);
  }

  async getPreviousFuelByVehicleId(
    vehicleId: string,
    currentFuelDate: Date | string,
  ): Promise<Fuel | null> {
    const vehicleFuels = this.fuels.filter(
      (fuel) => fuel.vehicleId === vehicleId,
    );

    if (vehicleFuels.length === 0) {
      return null;
    }

    const currentDate = new Date(currentFuelDate);

    // Filter fuels that are before the current fuel date
    const previousFuels = vehicleFuels.filter((fuel) => {
      const fuelDate = new Date(fuel.refueling_date);
      return fuelDate < currentDate;
    });

    if (previousFuels.length === 0) {
      return null;
    }

    // Sort by date descending and return the most recent previous fuel
    previousFuels.sort((a, b) => {
      const dateA = new Date(a.refueling_date).getTime();
      const dateB = new Date(b.refueling_date).getTime();
      return dateB - dateA;
    });

    return previousFuels[0];
  }

  async listFuelsByVehicleId({
    vehicleId,
    businessId,
    page,
    pageSize,
  }: ListFuelByVehicleIdProps): Promise<ListFuelProps> {
    const skip = (page - 1) * pageSize;

    // Filter fuels by vehicleId and businessId
    const filteredFuels = this.fuels.filter(
      (fuel) => fuel.vehicleId === vehicleId && fuel.businessId === businessId,
    );

    // Sort by created_at descending (most recent first)
    const sortedFuels = filteredFuels.sort((a, b) => {
      const dateA = new Date(a.created_at).getTime();
      const dateB = new Date(b.created_at).getTime();
      return dateB - dateA;
    });

    // Paginate
    const paginatedFuels = sortedFuels.slice(skip, skip + pageSize);

    return {
      data: paginatedFuels,
      total: sortedFuels.length,
    };
  }
}

export { InMemoryFuelRepository };
