import database from "@/../infra/database";
import {
  Fine,
  CreateFineProps,
  ListFineProps,
  ListFineByBusinessIdProps,
  UpdateFine,
} from "../dtos/fine-dto";

import { IFineRepository } from "./IFine-repository";

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
        {
          branchId: { contains: normalizedSearch, mode: "insensitive" },
        },
        {
          driver: {
            OR: [
              {
                id: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              { name: { contains: normalizedSearch, mode: "insensitive" } },
              { cpf: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
        },
        {
          vehicle: {
            OR: [
              {
                id: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
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
        {
          ...(currentUserRole === "MASTER"
            ? {
                businessId: { contains: normalizedSearch, mode: "insensitive" },
              }
            : {}),
        },
        ...(numericSearch ? [{ amount: parseFloat(normalizedSearch) }] : []),
      );
    }

    const whereCondition: any = {
      ...(currentUserRole !== "MASTER" && { businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const [fineData, total] = await Promise.all([
      this.prisma.fine.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        include: {
          business: { select: { corporate_reason: true } },
          branch: { select: { corporate_reason: true } },
          driver: { select: { name: true, cpf: true } },
          vehicle: { select: { license_plate: true, description: true } },
          ...(currentUserRole === "MASTER" && {
            business: {
              select: {
                corporate_reason: true,
              },
            },
          }),
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
      }),
      this.prisma.fine.count({
        where: whereCondition,
      }),
    ]);

    return {
      data: fineData,
      total,
    };
  }

  async *streamFinesForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): AsyncGenerator<any> {
    const normalizedSearch = search ? search.trim().toLowerCase() : "";
    const orConditions: any[] = [];

    if (normalizedSearch) {
      const numericSearch = !isNaN(parseFloat(normalizedSearch));
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { location: { contains: normalizedSearch, mode: "insensitive" } },
        {
          branchId: { contains: normalizedSearch, mode: "insensitive" },
        },
        {
          driver: {
            OR: [
              {
                id: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              { name: { contains: normalizedSearch, mode: "insensitive" } },
              { cpf: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
        },
        {
          vehicle: {
            OR: [
              {
                id: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
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
        {
          ...(userRole === "MASTER"
            ? {
                businessId: { contains: normalizedSearch, mode: "insensitive" },
              }
            : {}),
        },
        ...(numericSearch ? [{ amount: parseFloat(normalizedSearch) }] : []),
      );
    }

    const whereCondition: any = {
      ...(userRole !== "MASTER" && { businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const batchSize = 1000;
    let cursor: string | undefined = undefined;

    while (true) {
      const fines: any = await this.prisma.fine.findMany({
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
          id: "asc",
        },
        take: batchSize,
        ...(cursor && {
          skip: 1,
          cursor: { id: cursor },
        }),
      });

      if (fines.length === 0) break;
      for (const fine of fines) {
        yield {
          id: fine.id,
          violation_date: fine.violation_date,
          due_date: fine.due_date,
          payment_date: fine.payment_date,
          amount: fine.amount?.toNumber(),
          points: fine.points,
          location: fine.location,
          observation: fine.observation,
          businessId: fine.businessId,
          ...(userRole === "MASTER"
            ? { businessName: fine.business.corporate_reason }
            : {}),
          branchId: fine.branchId,
          branchName: fine.branch.corporate_reason,
          driverId: fine.driverId,
          driverName: fine.driver.name,
          driverCpf: fine.driver.cpf,
          vehicleId: fine.vehicleId,
          vehicleLicensePlate: fine.vehicle.license_plate,
          vehicleDescription: fine.vehicle.description,
          trafficViolationCodeId: fine.trafficViolationCodeId,
          violationCode: `${fine.trafficViolationCode.code}-${fine.trafficViolationCode.sub_code}`,
          violationDescription: fine.trafficViolationCode.description,
          // 📍 GEOLOCATION: Proper null handling to avoid Number(null) = 0 issue
          latitude: fine.latitude,
          longitude: fine.longitude,
          latitude_original: fine.latitude_original,
          longitude_original: fine.longitude_original,
          location_source: fine.location_source,
          location_edited_by: fine.location_edited_by,
          location_edited_at: fine.location_edited_at,
          created_from: fine.created_from,
          created_at: fine.created_at,
          updated_at: fine.updated_at,
        };
      }

      cursor = fines[fines.length - 1].id;
    }
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
