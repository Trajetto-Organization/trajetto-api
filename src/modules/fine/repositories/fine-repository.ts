import database from "@/../infra/database";
import {
  Fine,
  CreateFineProps,
  ListFineProps,
  ListFineByBusinessIdProps,
  UpdateFine,
} from "../dtos/fine-dto";

import { IFineRepository } from "./IFine-repository";
import { formatDate, formatCurrency, formatCpf } from "@/config/format-values";

class FineRepository implements IFineRepository {
  constructor(private prisma = database) {}

  async createFine(fineData: CreateFineProps): Promise<Fine> {
    const fineCreated = await this.prisma.fine.create({
      data: {
        violation_date: fineData.violation_date,
        due_date: fineData.due_date,
        payment_date: fineData.payment_date,
        amount: fineData.amount,
        points: fineData.points,
        location: fineData.location,
        latitude: fineData.latitude,
        longitude: fineData.longitude,
        observation: fineData.observation,
        business: {
          connect: { id: fineData.businessId },
        },
        branch: {
          connect: { id: fineData.branchId },
        },
        driver: {
          connect: { id: fineData.driverId },
        },
        vehicle: {
          connect: { id: fineData.vehicleId },
        },
        trafficViolationCode: {
          connect: { id: fineData.trafficViolationCodeId },
        },
      },
      include: {
        business: { select: { corporate_reason: true } },
        branch: { select: { corporate_reason: true } },
        driver: { select: { name: true, cpf: true } },
        vehicle: { select: { license_plate: true, description: true } },
        trafficViolationCode: { select: { code: true, description: true } },
      },
    });

    return fineCreated;
  }

  async listFines({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
  }: ListFineByBusinessIdProps): Promise<ListFineProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      const numericSearch = !isNaN(parseFloat(normalizedSearch));

      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { location: { contains: normalizedSearch, mode: "insensitive" } },
        ...(numericSearch ? [{ amount: parseFloat(normalizedSearch) }] : []),
      );

      orConditions.push(
        {
          driver: {
            OR: [
              { name: { contains: normalizedSearch, mode: "insensitive" } },
              { cpf: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
        },
        {
          vehicle: {
            OR: [
              {
                license_plate: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              {
                description: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
            ],
          },
        },
        {
          trafficViolationCode: {
            OR: [
              { code: { contains: normalizedSearch, mode: "insensitive" } },
              {
                description: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
            ],
          },
        },
      );
    }

    const whereCondition: any = {
      ...(currentUserRole !== "MASTER" && { businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const fineData = await this.prisma.fine.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      include: {
        business: { select: { corporate_reason: true } },
        branch: { select: { corporate_reason: true } },
        driver: { select: { name: true, cpf: true } },
        vehicle: { select: { license_plate: true, description: true } },
        trafficViolationCode: {
          select: {
            code: true,
            sub_code: true,
            description: true,
            gravity: true,
            points: true,
          },
        },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    const total = await this.prisma.fine.count({
      where: whereCondition,
    });

    const transformedFineData = fineData.map((fine) => {
      return {
        id: fine.id ?? "N/A",
        violation_date: fine.violation_date ?? "N/A",
        due_date: fine.due_date ?? "N/A",
        payment_date: fine.payment_date ? fine.payment_date : null,
        amount: formatCurrency(Number(fine.amount)) ?? "N/A",
        points: fine.points ?? 0,
        location: fine.location ? fine.location : "N/A",
        observation: fine.observation ? fine.observation : "N/A",
        businessId: fine.businessId ?? "N/A",
        ...(currentUserRole === "MASTER"
          ? { businessName: fine.business.corporate_reason ?? "N/A" }
          : {}),
        branchId: fine.branchId ?? "N/A",
        branchName: fine.branch.corporate_reason ?? "N/A",
        driverId: fine.driverId ?? "N/A",
        driverName: fine.driver.name ?? "N/A",
        driverCpf: formatCpf(fine.driver.cpf) ?? "N/A",
        vehicleId: fine.vehicleId ?? "N/A",
        vehicleLicensePlate: fine.vehicle.license_plate ?? "N/A",
        vehicleDescription: fine.vehicle.description ?? "N/A",
        trafficViolationCodeId: fine.trafficViolationCodeId ?? "N/A",
        violationCode: `${fine.trafficViolationCode.code}-${fine.trafficViolationCode.sub_code}`,
        violationDescription: fine.trafficViolationCode.description ?? "N/A",
        // 📍 GEOLOCATION: Proper null handling to avoid Number(null) = 0 issue
        latitude: fine.latitude !== null ? Number(fine.latitude) : null,
        longitude: fine.longitude !== null ? Number(fine.longitude) : null,
        latitude_original:
          fine.latitude_original !== null
            ? Number(fine.latitude_original)
            : null,
        longitude_original:
          fine.longitude_original !== null
            ? Number(fine.longitude_original)
            : null,
        location_source: fine.location_source ?? null,
        location_edited_by: fine.location_edited_by ?? null,
        location_edited_at: fine.location_edited_at ?? null,
        created_from: fine.created_from,
        created_at: formatDate(fine.created_at, "pt-BR") ?? "N/A",
        updated_at: formatDate(fine.updated_at, "pt-BR") ?? "N/A",
      };
    });

    return {
      data: transformedFineData,
      total,
    };
  }

  async getAllFinesForExport(
    businessId: string,
    currentUserRole: string,
    search?: string,
  ): Promise<Fine[]> {
    const normalizedSearch = search ? search.trim().toLowerCase() : "";
    const orConditions: any[] = [];

    if (normalizedSearch) {
      const numericSearch = !isNaN(parseFloat(normalizedSearch));

      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { location: { contains: normalizedSearch, mode: "insensitive" } },
        ...(numericSearch ? [{ amount: parseFloat(normalizedSearch) }] : []),
      );

      orConditions.push(
        {
          driver: {
            OR: [
              { name: { contains: normalizedSearch, mode: "insensitive" } },
              { cpf: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
        },
        {
          vehicle: {
            OR: [
              {
                license_plate: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              {
                description: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
            ],
          },
        },
        {
          trafficViolationCode: {
            OR: [
              { code: { contains: normalizedSearch, mode: "insensitive" } },
              {
                description: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
            ],
          },
        },
      );
    }

    const whereCondition: any = {
      ...(currentUserRole !== "MASTER" && { businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const fineData = await this.prisma.fine.findMany({
      where: whereCondition,
      include: {
        business: { select: { corporate_reason: true } },
        branch: { select: { corporate_reason: true } },
        driver: { select: { name: true, cpf: true } },
        vehicle: { select: { license_plate: true, description: true } },
        trafficViolationCode: {
          select: {
            code: true,
            sub_code: true,
            description: true,
            gravity: true,
            points: true,
          },
        },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    const transformedFineData = fineData.map((fine) => {
      return {
        id: fine.id ?? "N/A",
        violation_date: fine.violation_date ?? "N/A",
        due_date: fine.due_date ?? "N/A",
        payment_date: fine.payment_date ? fine.payment_date : null,
        amount: formatCurrency(Number(fine.amount)) ?? 0,
        points: fine.points ?? 0,
        location: fine.location ?? null,
        observation: fine.observation ?? null,
        businessId: fine.businessId ?? "N/A",
        ...(currentUserRole === "MASTER"
          ? { businessName: fine.business.corporate_reason ?? "N/A" }
          : {}),
        branchId: fine.branchId ?? "N/A",
        branchName: fine.branch.corporate_reason ?? "N/A",
        driverId: fine.driverId ?? "N/A",
        driverName: fine.driver.name ?? "N/A",
        driverCpf: fine.driver.cpf ?? "N/A",
        vehicleId: fine.vehicleId ?? "N/A",
        vehicleLicensePlate: fine.vehicle.license_plate ?? "N/A",
        vehicleDescription: fine.vehicle.description ?? "N/A",
        trafficViolationCodeId: fine.trafficViolationCodeId ?? "N/A",
        violationCode: `${fine.trafficViolationCode.code}-${fine.trafficViolationCode.sub_code}`,
        violationDescription: fine.trafficViolationCode.description ?? "N/A",
        // 📍 GEOLOCATION: Proper null handling to avoid Number(null) = 0 issue
        latitude: fine.latitude !== null ? Number(fine.latitude) : null,
        longitude: fine.longitude !== null ? Number(fine.longitude) : null,
        latitude_original:
          fine.latitude_original !== null
            ? Number(fine.latitude_original)
            : null,
        longitude_original:
          fine.longitude_original !== null
            ? Number(fine.longitude_original)
            : null,
        location_source: fine.location_source ?? null,
        location_edited_by: fine.location_edited_by ?? null,
        location_edited_at: fine.location_edited_at ?? null,
        created_from: fine.created_from,
        created_at: fine.created_at,
        updated_at: fine.updated_at,
      };
    });

    return transformedFineData;
  }

  async updateFine({ fineData, fineId }: UpdateFine): Promise<Fine> {
    const filteredData = Object.fromEntries(
      Object.entries(fineData).filter(([_, value]) => value !== undefined),
    );

    const updatedFine = await this.prisma.fine.update({
      where: { id: fineId },
      data: filteredData,
      include: {
        business: { select: { corporate_reason: true } },
        branch: { select: { corporate_reason: true } },
        driver: { select: { name: true, cpf: true } },
        vehicle: { select: { license_plate: true, description: true } },
        trafficViolationCode: { select: { code: true, description: true } },
      },
    });

    return updatedFine;
  }

  async deleteFine(fineId: string): Promise<Fine> {
    const deletedFine = await this.prisma.fine.delete({
      where: { id: fineId },
    });

    return deletedFine;
  }

  async findFineById(fineId: string): Promise<Fine | null> {
    const fine = await this.prisma.fine.findUnique({
      where: { id: fineId },
      include: {
        business: { select: { corporate_reason: true } },
        branch: { select: { corporate_reason: true } },
        driver: { select: { name: true, cpf: true } },
        vehicle: { select: { license_plate: true, description: true } },
        trafficViolationCode: {
          select: {
            code: true,
            sub_code: true,
            description: true,
            gravity: true,
            points: true,
          },
        },
      },
    });

    return fine;
  }

  async findFinesByDriverId(driverId: string): Promise<Fine[]> {
    const fines = await this.prisma.fine.findMany({
      where: { driverId },
      include: {
        trafficViolationCode: { select: { code: true, description: true } },
        vehicle: { select: { license_plate: true } },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    return fines;
  }

  async findFinesByVehicleId(vehicleId: string): Promise<Fine[]> {
    const fines = await this.prisma.fine.findMany({
      where: { vehicleId },
      include: {
        driver: { select: { name: true } },
        trafficViolationCode: { select: { code: true, description: true } },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    return fines;
  }

  async getFinesByDateRange(
    businessId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Fine[]> {
    const fines = await this.prisma.fine.findMany({
      where: {
        businessId,
        violation_date: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: {
        driver: { select: { name: true } },
        vehicle: { select: { license_plate: true } },
        trafficViolationCode: { select: { code: true, description: true } },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    return fines;
  }
}

export { FineRepository };
