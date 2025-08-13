import database from "@/../infra/database";

import { formatDate, formatCurrency } from "@/config/format-values";
import { Decimal } from "@prisma/client/runtime/library";

import { IFuelRepository } from "./IFuel-repository";
import {
  Fuel,
  CreateFuelProps,
  ListFuelProps,
  ListFuelFormattedProps,
  ListFuelByBusinessIdProps,
  UpdateFuel,
  ListFuelBusinessProps,
  GetFuelByIdAndBusinessProps,
  FuelFormatted,
  FuelWithRelationsFormatted,
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
  }: ListFuelByBusinessIdProps): Promise<ListFuelFormattedProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { notes: { contains: normalizedSearch, mode: "insensitive" } },
        {
          vehicle: {
            OR: [
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
              { name: { contains: normalizedSearch, mode: "insensitive" } },
              { cnh: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
        },
        {
          fuelType: {
            description: { contains: normalizedSearch, mode: "insensitive" },
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
        refueling_date: "desc",
      },
    });

    const total = await this.prisma.fuel.count({
      where: whereCondition,
    });

    const transformedFuelData: FuelFormatted[] = fuelData.map((fuel) => ({
      id: fuel.id ?? "N/A",
      current_mileage: fuel.current_mileage ?? 0,
      liters_amount: fuel.liters_amount ?? "0,000",
      price_per_liter: formatCurrency(fuel.price_per_liter?.toNumber() ?? 0),
      total_amount: formatCurrency(fuel.total_amount?.toNumber() ?? 0),
      odometer_photo: fuel.odometer_photo ?? "N/A",
      odometer_verified: fuel.odometer_verified ?? false,
      notes: fuel.notes ?? "N/A",
      refueling_date: fuel.refueling_date ?? "N/A",
      businessId: fuel.businessId ?? "N/A",
      branchId: fuel.branchId ?? "N/A",
      vehicleId: fuel.vehicleId ?? "N/A",
      driverId: fuel.driverId ?? "N/A",
      fuelTypeId: fuel.fuelTypeId ?? "N/A",
      ...(currentUserRole === "MASTER"
        ? { business_name: fuel.business?.corporate_reason ?? "N/A" }
        : {}),
      branch_name: fuel.branch?.corporate_reason ?? "N/A",
      vehicle_description: fuel.vehicle?.description ?? "N/A",
      vehicle_license_plate: fuel.vehicle?.license_plate ?? "N/A",
      vehicle_brand: fuel.vehicle?.brand ?? "N/A",
      vehicle_model: fuel.vehicle?.model ?? "N/A",
      driver_name: fuel.driver?.name ?? "N/A",
      driver_cnh: fuel.driver?.cnh ?? "N/A",
      fuel_type_description: fuel.fuelType?.description ?? "N/A",
      created_at: formatDate(fuel.created_at, "pt-BR") ?? "N/A",
      updated_at: formatDate(fuel.updated_at, "pt-BR") ?? "N/A",
    }));

    return {
      data: transformedFuelData,
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

  async findFuelByIdWithRelations(
    fuelId: string,
  ): Promise<FuelWithRelationsFormatted | null> {
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

    if (!fuel) return null;

    return {
      ...fuel,
      liters_amount:
        fuel.liters_amount?.toFixed(3).replace(".", ",") ?? "0,000",
      price_per_liter: formatCurrency(fuel.price_per_liter?.toNumber() ?? 0),
      total_amount: formatCurrency(fuel.total_amount?.toNumber() ?? 0),
      refueling_date: formatDate(fuel.refueling_date, "pt-BR"),
      created_at: formatDate(fuel.created_at, "pt-BR"),
      updated_at: formatDate(fuel.updated_at, "pt-BR"),
    } as FuelWithRelationsFormatted;
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
  }: GetFuelByIdAndBusinessProps): Promise<FuelWithRelationsFormatted | null> {
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

    if (!fuel) return null;

    return {
      ...fuel,
      liters_amount:
        fuel.liters_amount?.toFixed(3).replace(".", ",") ?? "0,000",
      price_per_liter: formatCurrency(fuel.price_per_liter?.toNumber() ?? 0),
      total_amount: formatCurrency(fuel.total_amount?.toNumber() ?? 0),
      refueling_date: formatDate(fuel.refueling_date, "pt-BR"),
      created_at: formatDate(fuel.created_at, "pt-BR"),
      updated_at: formatDate(fuel.updated_at, "pt-BR"),
    } as FuelWithRelationsFormatted;
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
}

export { FuelRepository };
