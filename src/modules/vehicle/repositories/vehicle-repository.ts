import database from "@/../infra/database";
import { IVehicleRepository } from "./IVehicle-repository";

import {
  Vehicle,
  CreateVehicleProps,
  ListVehicleProps,
  ListVehicleByBusinessIdProps,
  UpdateVehicle,
  ListVehicleBusinessProps,
  GetVehicleByIdAndBusinessProps,
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

    const vehicleData = await this.prisma.vehicle.findMany({
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
    });

    const total = await this.prisma.vehicle.count({
      where: whereCondition,
    });

    return {
      data: vehicleData,
      total,
    };
  }

  async listVehicleBusiness({
    page,
    pageSize,
    businessId,
    search,
    driverId,
  }: ListVehicleBusinessProps): Promise<ListVehicleProps> {
    const skip = (page - 1) * pageSize;

    // Build search conditions (same logic as listVehicles)
    const orConditions = [];
    if (search) {
      orConditions.push(
        { license_plate: { contains: search, mode: "insensitive" as const } },
        { model: { contains: search, mode: "insensitive" as const } },
        { brand: { contains: search, mode: "insensitive" as const } },
      );
    }

    const whereCondition = {
      businessId,
      ...(driverId && { driverId: driverId }), // Filter by driver if provided
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const vehicleBusinessData = await this.prisma.vehicle.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      include: {
        fuelType: {
          select: {
            description: true,
          },
        },
        branch: {
          select: {
            corporate_reason: true,
          },
        },
        driver: {
          select: {
            name: true,
            cnh: true,
          },
        },
        vehicleType: {
          select: {
            description: true,
          },
        },
      },
      orderBy: {
        created_at: "desc",
      },
    });

    const total = await this.prisma.vehicle.count({
      where: whereCondition,
    });

    return { data: vehicleBusinessData, total };
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
}

export { VehicleRepository };
