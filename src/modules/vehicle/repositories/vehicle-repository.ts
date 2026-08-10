import database from "@/../infra/database";
import { IVehicleRepository } from "./IVehicle-repository";

import {
  Vehicle,
  CreateVehicleProps,
  ListVehicleProps,
  ListVehicleByBusinessIdProps,
  UpdateVehicle,
  GetVehicleByIdAndBusinessProps,
  SearchVehicleWithCursorProps,
  CursorPaginatedVehicle,
} from "../dtos/vehicle-dto";

class VehicleRepository implements IVehicleRepository {
  constructor(private prisma = database) {}

  async createVehicle(vehicleData: CreateVehicleProps): Promise<Vehicle> {
    const vehicleCreated = await this.prisma.vehicle.create({
      data: vehicleData,
    });

    return vehicleCreated;
  }

  async listVehicles({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
  }: ListVehicleByBusinessIdProps): Promise<ListVehicleProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { description: { contains: normalizedSearch, mode: "insensitive" } },
        { license_plate: { contains: normalizedSearch, mode: "insensitive" } },
        { brand: { contains: normalizedSearch, mode: "insensitive" } },
        { model: { contains: normalizedSearch, mode: "insensitive" } },
        { renavam: { contains: normalizedSearch, mode: "insensitive" } },
        { branchId: { contains: normalizedSearch, mode: "insensitive" } },
        { driverId: { contains: normalizedSearch, mode: "insensitive" } },
        { vehicleTypeId: { contains: normalizedSearch, mode: "insensitive" } },
        { fuelTypeId: { contains: normalizedSearch, mode: "insensitive" } },
        // Business ID and name (MASTER only)
        ...(currentUserRole === "MASTER"
          ? [
              {
                businessId: { contains: normalizedSearch, mode: "insensitive" },
              },
              {
                business: {
                  corporate_reason: {
                    contains: normalizedSearch,
                    mode: "insensitive",
                  },
                },
              },
            ]
          : []),
      );
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId: businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const [vehicleData, total] = await Promise.all([
      this.prisma.vehicle.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        include: {
          vehicleType: {
            select: {
              description: true,
            },
          },
          fuelType: {
            select: {
              description: true,
            },
          },
          driver: {
            select: {
              name: true,
              cnh: true,
            },
          },
          branch: {
            select: {
              corporate_reason: true,
            },
          },
          business: {
            select: {
              corporate_reason: true,
            },
          },
        },
        orderBy: {
          created_at: "desc",
        },
      }),
      this.prisma.vehicle.count({
        where: whereCondition,
      }),
    ]);

    return {
      data: vehicleData,
      total,
    };
  }

  async updateVehicle({
    vehicleData,
    vehicleId,
  }: UpdateVehicle): Promise<Vehicle> {
    const filteredData = Object.fromEntries(
      Object.entries(vehicleData).filter(([_, value]) => value !== undefined),
    );

    const updateVehicle = await this.prisma.vehicle.update({
      where: {
        id: vehicleId,
      },
      data: filteredData,
    });

    return updateVehicle;
  }

  async deleteVehicle(vehicleId: string): Promise<Vehicle> {
    const deleteVehicle = await this.prisma.vehicle.delete({
      where: {
        id: vehicleId,
      },
    });

    return deleteVehicle;
  }

  async findVehicleById(vehicleId: string): Promise<Vehicle | null> {
    const findVehicleById = await this.prisma.vehicle.findUnique({
      where: {
        id: vehicleId,
      },
      include: {
        vehicleType: true,
        fuelType: true,
        driver: true,
        branch: true,
      },
    });

    return findVehicleById;
  }

  async findVehicleByLicensePlate(
    licensePlate: string,
  ): Promise<Vehicle | null> {
    const findVehicleByLicensePlate = await this.prisma.vehicle.findFirst({
      where: {
        license_plate: {
          equals: licensePlate,
          mode: "insensitive",
        },
      },
    });

    return findVehicleByLicensePlate;
  }

  async findVehicleByRenavam(renavam: string): Promise<Vehicle | null> {
    const findVehicleByRenavam = await this.prisma.vehicle.findFirst({
      where: {
        renavam: {
          equals: renavam,
          mode: "insensitive",
        },
      },
    });

    return findVehicleByRenavam;
  }

  async getVehicleByIdAndBusiness({
    businessId,
    vehicleId,
  }: GetVehicleByIdAndBusinessProps): Promise<Vehicle | null> {
    const getVehicleByIdAndBusiness = await this.prisma.vehicle.findUnique({
      where: {
        businessId,
        id: vehicleId,
      },
    });

    return getVehicleByIdAndBusiness;
  }

  async findVehiclesByFuelTypeId(fuelTypeId: string): Promise<Vehicle[]> {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { fuelTypeId },
      include: {
        fuelType: { select: { description: true } },
      },
      orderBy: { license_plate: "asc" },
    });

    return vehicles;
  }

  async *streamVehiclesForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): AsyncGenerator<any> {
    const normalizedSearch = search ? search.trim().toLowerCase() : "";
    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { description: { contains: normalizedSearch, mode: "insensitive" } },
        { license_plate: { contains: normalizedSearch, mode: "insensitive" } },
        { brand: { contains: normalizedSearch, mode: "insensitive" } },
        { model: { contains: normalizedSearch, mode: "insensitive" } },
        { renavam: { contains: normalizedSearch, mode: "insensitive" } },
        { branchId: { contains: normalizedSearch, mode: "insensitive" } },
        { driverId: { contains: normalizedSearch, mode: "insensitive" } },
        ...(userRole === "MASTER"
          ? [
              {
                businessId: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
            ]
          : []),
      );
    }

    const whereCondition: any = {
      ...(userRole !== "MASTER" && { businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const batchSize = 1000;
    let cursor: string | undefined = undefined;

    while (true) {
      const vehicles: any = await this.prisma.vehicle.findMany({
        where: whereCondition,
        include: {
          vehicleType: { select: { description: true } },
          fuelType: { select: { description: true } },
          driver: { select: { name: true, cpf: true } },
          branch: { select: { corporate_reason: true } },
          business: { select: { corporate_reason: true } },
        },
        orderBy: { id: "asc" },
        take: batchSize,
        ...(cursor && {
          skip: 1,
          cursor: { id: cursor },
        }),
      });

      if (vehicles.length === 0) break;
      for (const v of vehicles) {
        yield {
          id: v.id,
          description: v.description,
          license_plate: v.license_plate,
          brand: v.brand,
          model: v.model,
          acquisition_date: v.acquisition_date,
          fleet_type: v.fleet_type,
          fleet_id: v.fleet_id,
          current_mileage: v.current_mileage,
          last_maintenance_mileage: v.last_maintenance_mileage,
          last_maintenance_date: v.last_maintenance_date,
          maintenance_interval_km: v.maintenance_interval_km,
          maintenance_interval_months: v.maintenance_interval_months,
          renavam: v.renavam,
          manufacturing_year: v.manufacturing_year,
          model_year: v.model_year,
          km_per_liter: v.km_per_liter,
          number_of_axles: v.number_of_axles,
          status: v.status,
          vehicleTypeName: v.vehicleType?.description || null,
          fuelTypeName: v.fuelType?.description || null,
          driverName: v.driver?.name || null,
          driverCpf: v.driver?.cpf || null,
          branchName: v.branch?.corporate_reason || null,
          businessId: v.businessId,
          ...(userRole === "MASTER"
            ? { businessName: v.business.corporate_reason }
            : {}),
          created_at: v.created_at,
          updated_at: v.updated_at,
        };
      }

      cursor = vehicles[vehicles.length - 1].id;
    }
  }

  async searchVehicleWithCursor({
    limit = 10,
    cursor,
    businessId,
    driverId,
    search,
  }: SearchVehicleWithCursorProps): Promise<CursorPaginatedVehicle> {
    const items = await this.prisma.vehicle.findMany({
      where: {
        businessId,
        ...(driverId ? { driverId } : {}),
        status: {
          in: ["ACTIVE", "IN_ROUTE"],
        },
        ...(search && {
          OR: [
            { description: { contains: search, mode: "insensitive" } },
            { license_plate: { contains: search, mode: "insensitive" } },
            { brand: { contains: search, mode: "insensitive" } },
            { model: { contains: search, mode: "insensitive" } },
            { renavam: { contains: search, mode: "insensitive" } },
          ],
        }),
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { created_at: "desc" },
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countVehiclesForExport(
    businessId: string,
    userRole: string,
  ): Promise<number> {
    const whereCondition: any = {
      ...(userRole !== "MASTER" && { businessId }),
    };

    const vehiclesCount = await this.prisma.vehicle.count({
      where: whereCondition,
    });

    return vehiclesCount;
  }
}

export { VehicleRepository };
