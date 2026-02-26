import database from "@/../infra/database";

import { Decimal } from "@prisma/client/runtime/library";
import { IFuelRepository } from "./IFuel-repository";

import {
  Fuel,
  CreateFuelProps,
  ListFuelProps,
  ListFuelByBusinessIdProps,
  UpdateFuel,
  ListFuelBusinessProps,
  GetFuelByIdAndBusinessProps,
  ListFuelByVehicleIdProps,
} from "../dtos/fuel-dto";

class FuelRepository implements IFuelRepository {
  constructor(private prisma = database) {}

  async createFuel(fuelData: CreateFuelProps): Promise<Fuel> {
    // Calculate total amount if not provided
    const litersAmount = new Decimal(fuelData.liters_amount.toString());
    const pricePerLiter = new Decimal(fuelData.price_per_liter.toString());

    const totalAmount = fuelData.total_amount
      ? new Decimal(fuelData.total_amount.toString())
      : litersAmount.mul(pricePerLiter);

    const fuelCreated = await this.prisma.fuel.create({
      data: {
        ...fuelData,
        liters_amount: litersAmount,
        price_per_liter: pricePerLiter,
        total_amount: totalAmount,
        odometer_verified: fuelData.odometer_verified ?? false,
        odometer_photo: fuelData.odometer_photo as string,
        branchId: fuelData.branchId!,
        driverId: fuelData.driverId!,
      },
    });

    return fuelCreated;
  }

  async listFuels({
    page,
    pageSize,
    businessId,
    currentUserRole,
    search,
  }: ListFuelByBusinessIdProps): Promise<ListFuelProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { notes: { contains: normalizedSearch, mode: "insensitive" } },
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
        {
          branchId: { contains: normalizedSearch, mode: "insensitive" },
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
                description: {
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
              { brand: { contains: normalizedSearch, mode: "insensitive" } },
              { model: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
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
              { cnh: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
        },
        {
          fuelType: {
            OR: [
              {
                id: {
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
      );
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId: businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const fuelData = await this.prisma.fuel.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      include: {
        business: {
          select: {
            corporate_reason: true,
          },
        },
        branch: {
          select: {
            corporate_reason: true,
          },
        },
        vehicle: {
          select: {
            description: true,
            license_plate: true,
            brand: true,
            model: true,
          },
        },
        driver: {
          select: {
            name: true,
            cnh: true,
          },
        },
        fuelType: {
          select: {
            description: true,
          },
        },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    const total = await this.prisma.fuel.count({
      where: whereCondition,
    });

    return {
      data: fuelData,
      total,
    };
  }

  async listFuelBusiness({
    page,
    pageSize,
    businessId,
  }: ListFuelBusinessProps): Promise<ListFuelProps> {
    const skip = (page - 1) * pageSize;

    const fuelBusinessData = await this.prisma.fuel.findMany({
      skip,
      take: pageSize,
      where: {
        businessId,
      },
    });

    const total = await this.prisma.fuel.count({
      where: {
        businessId,
      },
    });

    return { data: fuelBusinessData, total };
  }

  async updateFuel({ fuelData, fuelId }: UpdateFuel): Promise<Fuel> {
    const filteredData = Object.fromEntries(
      Object.entries(fuelData).filter(([_, value]) => value !== undefined),
    );

    // Calculate total amount if liters_amount or price_per_liter are updated
    if (filteredData.liters_amount || filteredData.price_per_liter) {
      const currentFuel = await this.prisma.fuel.findUnique({
        where: { id: fuelId },
      });

      if (currentFuel) {
        const litersAmount = filteredData.liters_amount
          ? new Decimal(filteredData.liters_amount.toString())
          : currentFuel.liters_amount;
        const pricePerLiter = filteredData.price_per_liter
          ? new Decimal(filteredData.price_per_liter.toString())
          : currentFuel.price_per_liter;

        filteredData.total_amount = litersAmount.mul(pricePerLiter);

        if (filteredData.liters_amount) {
          filteredData.liters_amount = litersAmount;
        }
        if (filteredData.price_per_liter) {
          filteredData.price_per_liter = pricePerLiter;
        }
      }
    }

    const updatedFuel = await this.prisma.fuel.update({
      where: { id: fuelId },
      data: filteredData,
    });

    return updatedFuel;
  }

  async deleteFuel(fuelId: string): Promise<Fuel> {
    const deletedFuel = await this.prisma.fuel.delete({
      where: { id: fuelId },
    });

    return deletedFuel;
  }

  async findFuelById(fuelId: string): Promise<Fuel | null> {
    const fuel = await this.prisma.fuel.findUnique({
      where: { id: fuelId },
    });

    return fuel;
  }

  async findFuelByIdWithRelations(fuelId: string): Promise<any | null> {
    const fuel = await this.prisma.fuel.findUnique({
      where: { id: fuelId },
      include: {
        business: {
          select: {
            id: true,
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        branch: {
          select: {
            id: true,
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            current_mileage: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cnh: true,
          },
        },
        fuelType: {
          select: {
            id: true,
            description: true,
          },
        },
      },
    });

    return fuel;
  }

  async getFuelByIdAndBusiness({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<Fuel | null> {
    const fuel = await this.prisma.fuel.findFirst({
      where: {
        id: fuelId,
        businessId: businessId,
      },
    });

    return fuel;
  }

  async getFuelByIdAndBusinessWithRelations({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<any | null> {
    const fuel = await this.prisma.fuel.findFirst({
      where: {
        id: fuelId,
        businessId: businessId,
      },
      include: {
        business: {
          select: {
            id: true,
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        branch: {
          select: {
            id: true,
            corporate_reason: true,
            fantasy_name: true,
          },
        },
        vehicle: {
          select: {
            id: true,
            description: true,
            license_plate: true,
            brand: true,
            model: true,
            current_mileage: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            cnh: true,
          },
        },
        fuelType: {
          select: {
            id: true,
            description: true,
          },
        },
      },
    });

    return fuel;
  }

  async findFuelsByVehicleId(vehicleId: string): Promise<Fuel[]> {
    const fuels = await this.prisma.fuel.findMany({
      where: { vehicleId },
    });

    return fuels;
  }

  async findFuelsByDriverId(driverId: string): Promise<Fuel[]> {
    const fuels = await this.prisma.fuel.findMany({
      where: { driverId },
    });

    return fuels;
  }

  async findFuelsByFuelTypeId(fuelTypeId: string): Promise<Fuel[]> {
    const fuels = await this.prisma.fuel.findMany({
      where: { fuelTypeId },
    });

    return fuels;
  }

  async getAllFuelsForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): Promise<any[]> {
    const normalizedSearch = search ? search.trim().toLowerCase() : "";
    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { notes: { contains: normalizedSearch, mode: "insensitive" } },
        // Business ID and name (MASTER only)
        ...(userRole === "MASTER"
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
        {
          branchId: { contains: normalizedSearch, mode: "insensitive" },
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
                description: {
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
              { brand: { contains: normalizedSearch, mode: "insensitive" } },
              { model: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
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
              { cnh: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
        },
        {
          fuelType: {
            OR: [
              {
                id: {
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
      );
    }

    const whereCondition = {
      ...(userRole !== "MASTER" && { businessId: businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const fuels = await this.prisma.fuel.findMany({
      where: whereCondition,
      include: {
        business: {
          select: {
            corporate_reason: true,
          },
        },
        branch: {
          select: {
            corporate_reason: true,
          },
        },
        vehicle: {
          select: {
            description: true,
            license_plate: true,
            brand: true,
            model: true,
          },
        },
        driver: {
          select: {
            name: true,
            cnh: true,
          },
        },
        fuelType: {
          select: {
            description: true,
          },
        },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    return fuels.map((fuel) => ({
      id: fuel.id,
      vehicleLicensePlate: fuel.vehicle?.license_plate || "N/A",
      vehicleDescription: fuel.vehicle?.description || "N/A",
      vehicleBrand: fuel.vehicle?.brand || "N/A",
      vehicleModel: fuel.vehicle?.model || "N/A",
      driverName: fuel.driver?.name || "N/A",
      driverCnh: fuel.driver?.cnh || "N/A",
      fuelTypeDescription: fuel.fuelType?.description || "N/A",
      litersAmount: fuel.liters_amount?.toFixed(3) || "0,000",
      pricePerLiter: fuel.price_per_liter?.toNumber() || 0,
      totalAmount: fuel.total_amount?.toNumber() || 0,
      currentMileage: fuel.current_mileage || 0,
      odometerVerified: fuel.odometer_verified ? "Sim" : "Não",
      notes: fuel.notes || "N/A",
      refueling_date: fuel.refueling_date,
      branchName: fuel.branch?.corporate_reason || "N/A",
      ...(userRole === "MASTER" && {
        businessName: fuel.business?.corporate_reason || "N/A",
      }),
      latitude: fuel.latitude !== null ? Number(fuel.latitude) : "N/A",
      longitude: fuel.longitude !== null ? Number(fuel.longitude) : "N/A",
      created_at: fuel.created_at,
      updated_at: fuel.updated_at,
    }));
  }

  async getPreviousFuelByVehicleId(
    vehicleId: string,
    currentFuelDate: Date | string,
  ): Promise<Fuel | null> {
    const previousFuel = await this.prisma.fuel.findFirst({
      where: {
        vehicleId,
        refueling_date: {
          lt: new Date(currentFuelDate),
        },
      },
      orderBy: {
        refueling_date: "desc",
      },
    });

    return previousFuel;
  }

  async listFuelsByVehicleId({
    vehicleId,
    businessId,
    page,
    pageSize,
  }: ListFuelByVehicleIdProps): Promise<ListFuelProps> {
    const skip = (page - 1) * pageSize;

    const whereCondition = {
      vehicleId,
      businessId,
    };

    const fuelData = await this.prisma.fuel.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      include: {
        business: {
          select: {
            corporate_reason: true,
          },
        },
        branch: {
          select: {
            corporate_reason: true,
          },
        },
        vehicle: {
          select: {
            description: true,
            license_plate: true,
            brand: true,
            model: true,
          },
        },
        driver: {
          select: {
            name: true,
            cnh: true,
          },
        },
        fuelType: {
          select: {
            description: true,
          },
        },
      },
      orderBy: {
        created_at: "desc",
      },
    });

    const total = await this.prisma.fuel.count({
      where: whereCondition,
    });

    return {
      data: fuelData,
      total,
    };
  }
}

export { FuelRepository };
