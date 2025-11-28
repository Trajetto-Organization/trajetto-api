import { v4 as uuidV4 } from "uuid";

import { Decimal } from "@prisma/client/runtime/library";
import { IFineRepository } from "../IFine-repository";

import {
  Fine,
  CreateFineProps,
  ListFineProps,
  ListFineByBusinessIdProps,
  UpdateFine,
} from "../../dtos/fine-dto";

class InMemoryFineRepository implements IFineRepository {
  public fines: Fine[] = [];

  async createFine(fineData: CreateFineProps): Promise<Fine> {
    const newFine: Fine = {
      id: uuidV4(),
      violation_date: fineData.violation_date,
      due_date: fineData.due_date,
      payment_date: fineData.payment_date || null,
      amount:
        typeof fineData.amount === "number"
          ? new Decimal(fineData.amount)
          : fineData.amount,
      points: fineData.points,
      location: fineData.location || null,
      observation: fineData.observation || null,
      businessId: fineData.businessId,
      branchId: fineData.branchId,
      driverId: fineData.driverId,
      vehicleId: fineData.vehicleId,
      trafficViolationCodeId: fineData.trafficViolationCodeId,
      // Geolocation fields
      latitude: fineData.latitude || null,
      longitude: fineData.longitude || null,
      latitude_original: fineData.latitude_original || null,
      longitude_original: fineData.longitude_original || null,
      location_source: fineData.location_source || null,
      location_edited_by: null,
      location_edited_at: null,
      created_from: fineData.created_from || "WEB",
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.fines.push(newFine);
    return newFine;
  }

  async listFines({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
  }: ListFineByBusinessIdProps): Promise<ListFineProps> {
    let filteredFines = this.fines.filter(
      (fine) => fine.businessId === businessId,
    );

    if (search) {
      const searchTerm = search.toLowerCase();
      filteredFines = filteredFines.filter(
        (fine) =>
          fine.id.toLowerCase().includes(searchTerm) ||
          fine.location?.toLowerCase().includes(searchTerm) ||
          fine.observation?.toLowerCase().includes(searchTerm) ||
          fine.points.toString().includes(searchTerm) ||
          fine.amount.toString().includes(searchTerm),
      );
    }

    const skip = (page - 1) * pageSize;
    const data = filteredFines.slice(skip, skip + pageSize);

    const total = filteredFines.length;
    return { data, total };
  }

  async getAllFinesForExport(
    businessId: string,
    currentUserRole: string,
    search?: string,
  ): Promise<Fine[]> {
    let filteredFines = this.fines.filter(
      (fine) => fine.businessId === businessId,
    );

    if (search) {
      const searchTerm = search.toLowerCase();
      filteredFines = filteredFines.filter(
        (fine) =>
          fine.id.toLowerCase().includes(searchTerm) ||
          fine.location?.toLowerCase().includes(searchTerm) ||
          fine.observation?.toLowerCase().includes(searchTerm) ||
          fine.points.toString().includes(searchTerm) ||
          fine.amount.toString().includes(searchTerm),
      );
    }

    return filteredFines;
  }

  async updateFine({ fineData, fineId }: UpdateFine): Promise<Fine> {
    const index = this.fines.findIndex((fine) => fine.id === fineId);

    if (index === -1) {
      throw new Error("Fine not found");
    }

    const filteredData = Object.fromEntries(
      Object.entries(fineData).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    // Convert amount to Decimal if it's being updated
    if (filteredData.amount !== undefined) {
      filteredData.amount =
        typeof filteredData.amount === "number"
          ? new Decimal(filteredData.amount)
          : filteredData.amount;
    }

    const updatedFine: Fine = {
      ...this.fines[index],
      ...filteredData,
      updated_at: new Date(),
    };

    this.fines[index] = updatedFine;
    return updatedFine;
  }

  async deleteFine(fineId: string): Promise<Fine> {
    const index = this.fines.findIndex((fine) => fine.id === fineId);

    if (index === -1) {
      throw new Error("Fine not found");
    }

    const deletedFine = this.fines.splice(index, 1)[0];
    return deletedFine;
  }

  async findFineById(fineId: string): Promise<Fine | null> {
    const found = this.fines.find((fine) => fine.id === fineId);
    return found || null;
  }

  async findFinesByDriverId(driverId: string): Promise<Fine[]> {
    return this.fines.filter((fine) => fine.driverId === driverId);
  }

  async findFinesByVehicleId(vehicleId: string): Promise<Fine[]> {
    return this.fines.filter((fine) => fine.vehicleId === vehicleId);
  }

  async getFinesByDateRange(
    businessId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Fine[]> {
    return this.fines.filter(
      (fine) =>
        fine.businessId === businessId &&
        new Date(fine.violation_date) >= startDate &&
        new Date(fine.violation_date) <= endDate,
    );
  }

  async findFinesByBusinessId(businessId: string): Promise<Fine[]> {
    return this.fines.filter((fine) => fine.businessId === businessId);
  }

  async findFinesByBusinessIdAndDriverId(
    businessId: string,
    driverId: string,
  ): Promise<Fine[]> {
    return this.fines.filter(
      (fine) => fine.businessId === businessId && fine.driverId === driverId,
    );
  }

  async findFinesByBusinessIdAndVehicleId(
    businessId: string,
    vehicleId: string,
  ): Promise<Fine[]> {
    return this.fines.filter(
      (fine) => fine.businessId === businessId && fine.vehicleId === vehicleId,
    );
  }

  async findFinesByTrafficViolationCodeId(
    trafficViolationCodeId: string,
  ): Promise<Fine[]> {
    return this.fines.filter(
      (fine) => fine.trafficViolationCodeId === trafficViolationCodeId,
    );
  }

  async findPaidFines(businessId: string): Promise<Fine[]> {
    return this.fines.filter(
      (fine) => fine.businessId === businessId && fine.payment_date !== null,
    );
  }

  async findUnpaidFines(businessId: string): Promise<Fine[]> {
    return this.fines.filter(
      (fine) => fine.businessId === businessId && fine.payment_date === null,
    );
  }

  async findOverdueFines(businessId: string): Promise<Fine[]> {
    const today = new Date();
    return this.fines.filter(
      (fine) =>
        fine.businessId === businessId &&
        fine.payment_date === null &&
        new Date(fine.due_date) < today,
    );
  }
}

export { InMemoryFineRepository };
