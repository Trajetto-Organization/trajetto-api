import database from "@/../infra/database";
import { formatDate } from "@/config/format-values";

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

    const transformedVehicleData = vehicleData.map((vehicle) => ({
      id: vehicle.id ?? "N/A",
      description: vehicle.description ?? "N/A",
      license_plate: vehicle.license_plate ?? "N/A",
      brand: vehicle.brand ?? "N/A",
      model: vehicle.model ?? "N/A",
      acquisition_date: vehicle.acquisition_date ?? "N/A",
      fleet_type: vehicle.fleet_type ?? "N/A",
      fleet_id: vehicle.fleet_id ?? "N/A",
      last_maintenance_date: vehicle.last_maintenance_date ?? "N/A",
      current_mileage: vehicle.current_mileage ?? "N/A",
      last_maintenance_mileage:
        Number(vehicle.last_maintenance_mileage) ?? "N/A",
      maintenance_interval_km: vehicle.maintenance_interval_km ?? "N/A",
      maintenance_interval_months: vehicle.maintenance_interval_months ?? "N/A",
      renavam: vehicle.renavam ?? "N/A",
      manufacturing_year: vehicle.manufacturing_year ?? "N/A",
      model_year: vehicle.model_year ?? "N/A",
      km_per_liter: vehicle.km_per_liter ?? "N/A",
      number_of_axles: vehicle.number_of_axles ?? "N/A",
      status: vehicle.status ?? "N/A",
      vehicleTypeId: vehicle.vehicleTypeId ?? "N/A",
      vehicleTypeDescription: vehicle.vehicleType?.description ?? "N/A",
      fuelTypeId: vehicle.fuelTypeId ?? "N/A",
      fuelTypeDescription: vehicle.fuelType?.description ?? "N/A",
      driverId: vehicle.driverId ?? "N/A",
      driverName: vehicle.driver?.name ?? "N/A",
      driverCnh: vehicle.driver?.cnh ?? "N/A",
      branchId: vehicle.branchId ?? "N/A",
      branchName: vehicle.branch?.corporate_reason ?? "N/A",
      businessId: vehicle.businessId ?? "N/A",
      ...(currentUserRole === "MASTER"
        ? { business_name: vehicle.business.corporate_reason ?? "N/A" }
        : {}),
      created_at: formatDate(vehicle.created_at, "pt-BR") ?? "N/A",
      updated_at: formatDate(vehicle.updated_at, "pt-BR") ?? "N/A",
    }));

    return {
      data: transformedVehicleData,
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

    // Transform data to match Vehicle interface (same as listVehicles)
    const transformedVehicleData = vehicleBusinessData.map((vehicle) => ({
      id: vehicle.id,
      description: vehicle.description ?? "N/A",
      license_plate: vehicle.license_plate ?? "N/A",
      brand: vehicle.brand ?? "N/A",
      model: vehicle.model ?? "N/A",
      acquisition_date: vehicle.acquisition_date ?? "N/A",
      fleet_type: vehicle.fleet_type ?? "N/A",
      fleet_id: vehicle.fleet_id ?? "N/A",
      last_maintenance_date: vehicle.last_maintenance_date ?? "N/A",
      current_mileage: vehicle.current_mileage ?? "N/A",
      last_maintenance_mileage:
        Number(vehicle.last_maintenance_mileage) ?? "N/A",
      maintenance_interval_km: vehicle.maintenance_interval_km ?? "N/A",
      maintenance_interval_months: vehicle.maintenance_interval_months ?? "N/A",
      renavam: vehicle.renavam ?? "N/A",
      manufacturing_year: vehicle.manufacturing_year ?? "N/A",
      model_year: vehicle.model_year ?? "N/A",
      km_per_liter: vehicle.km_per_liter ?? "N/A",
      number_of_axles: vehicle.number_of_axles ?? "N/A",
      status: vehicle.status ?? "N/A",
      vehicleTypeId: vehicle.vehicleTypeId ?? "N/A",
      vehicleTypeDescription: vehicle.vehicleType?.description ?? "N/A",
      fuelTypeId: vehicle.fuelTypeId ?? "N/A",
      fuelTypeDescription: vehicle.fuelType?.description ?? "N/A",
      driverId: vehicle.driverId ?? "N/A",
      driverName: vehicle.driver?.name ?? "N/A",
      driverCnh: vehicle.driver?.cnh ?? "N/A",
      branchId: vehicle.branchId ?? "N/A",
      branchName: vehicle.branch?.corporate_reason ?? "N/A",
      businessId: vehicle.businessId ?? "N/A",
      created_at: formatDate(vehicle.created_at, "pt-BR") ?? "N/A",
      updated_at: formatDate(vehicle.updated_at, "pt-BR") ?? "N/A",
    }));

    return { data: transformedVehicleData, total };
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

  // Analytics methods
  async countVehiclesByStatus(businessId: string): Promise<{
    totalVehicles: number;
    activeVehicles: number;
    inactiveVehicles: number;
    blockedVehicles: number;
    inRouteVehicles: number;
  }> {
    // Execute all counts in parallel for better performance
    const [total, active, inactive, blocked, inRoute] = await Promise.all([
      this.prisma.vehicle.count({ where: { businessId } }),
      this.prisma.vehicle.count({ where: { businessId, status: "ACTIVE" } }),
      this.prisma.vehicle.count({ where: { businessId, status: "INACTIVE" } }),
      this.prisma.vehicle.count({ where: { businessId, status: "BLOCKED" } }),
      this.prisma.vehicle.count({ where: { businessId, status: "IN_ROUTE" } }),
    ]);

    return {
      totalVehicles: total,
      activeVehicles: active,
      inactiveVehicles: inactive,
      blockedVehicles: blocked,
      inRouteVehicles: inRoute,
    };
  }

  async getVehicleUtilizationData(
    businessId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<
    Array<{
      vehicleId: string;
      vehiclePlate: string;
      totalRoutes: number;
      totalDistance: number;
    }>
  > {
    const routes = await this.prisma.route.groupBy({
      by: ["vehicleId"],
      where: {
        businessId,
        created_at: {
          gte: startDate,
          lte: endDate,
        },
      },
      _count: {
        id: true,
      },
      _sum: {
        distance: true,
      },
    });

    // Get vehicle details for each vehicleId (filter out null values)
    const routesWithVehicles = routes.filter(
      (route): route is typeof route & { vehicleId: string } =>
        route.vehicleId !== null,
    );

    const vehicleData = await Promise.all(
      routesWithVehicles.map(async (route) => {
        const vehicle = await this.prisma.vehicle.findUnique({
          where: { id: route.vehicleId },
          select: {
            id: true,
            license_plate: true,
          },
        });

        return {
          vehicleId: route.vehicleId,
          vehiclePlate: vehicle?.license_plate || "N/A",
          totalRoutes: route._count.id,
          totalDistance: route._sum.distance || 0,
        };
      }),
    );

    return vehicleData;
  }
}

export { VehicleRepository };
