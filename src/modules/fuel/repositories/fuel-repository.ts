import database from "@/../infra/database";

import { Decimal } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client";
import { IFuelRepository } from "./IFuel-repository";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";

import {
  Fuel,
  CreateFuelProps,
  ListFuelProps,
  ListFuelByBusinessIdProps,
  UpdateFuel,
  GetFuelByIdAndBusinessProps,
  SearchFuelByVehicleWithCursorProps,
  CursorPaginatedFuel,
} from "../dtos/fuel-dto";

import { buildSearchOr } from "@/shared/pagination/search-or";

class FuelRepository implements IFuelRepository {
  constructor(private prisma = database) {}

  async createFuel(fuelData: CreateFuelProps): Promise<Fuel> {
    // Calculate total amount if not provided
    const litersAmount = new Decimal(fuelData.liters_amount.toString());
    const pricePerLiter = new Decimal(fuelData.price_per_liter.toString());

    // Never trust a total supplied by a client.
    const totalAmount = litersAmount.mul(pricePerLiter);

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

  async findBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<Fuel | null> {
    return this.prisma.fuel.findFirst({
      where: {
        businessId,
        client_submission_id: clientSubmissionId,
      },
    });
  }

  // `afterCreate` runs inside the same transaction, only when this call
  // actually created the record — an idempotent retry returns the original
  // row and never fires it. It is how the use case publishes the outbox
  // event atomically without this method giving up its serializable retry.
  async createFuelWithMileage(
    fuelData: CreateFuelProps,
    afterCreate?: (tx: Prisma.TransactionClient, fuel: Fuel) => Promise<void>,
  ): Promise<{ fuel: Fuel; created: boolean }> {
    const executeTransaction = async () =>
      this.prisma.$transaction(
        async (transaction) => {
          if (fuelData.client_submission_id) {
            const existing = await transaction.fuel.findFirst({
              where: {
                businessId: fuelData.businessId,
                client_submission_id: fuelData.client_submission_id,
              },
            });

            if (existing) {
              return { fuel: existing, created: false };
            }
          }

          const mileageUpdate = await transaction.vehicle.updateMany({
            where: {
              id: fuelData.vehicleId,
              businessId: fuelData.businessId,
              current_mileage: { lt: fuelData.current_mileage },
            },
            data: { current_mileage: fuelData.current_mileage },
          });

          if (mileageUpdate.count !== 1) {
            throw new VehicleMileageInvalidError();
          }

          const litersAmount = new Decimal(fuelData.liters_amount.toString());
          const pricePerLiter = new Decimal(
            fuelData.price_per_liter.toString(),
          );

          const fuel = await transaction.fuel.create({
            data: {
              ...fuelData,
              liters_amount: litersAmount,
              price_per_liter: pricePerLiter,
              total_amount: litersAmount.mul(pricePerLiter),
              odometer_verified: fuelData.odometer_verified ?? false,
              odometer_photo: fuelData.odometer_photo as string,
              branchId: fuelData.branchId!,
              driverId: fuelData.driverId!,
            },
          });

          if (afterCreate) {
            await afterCreate(transaction, fuel);
          }

          return { fuel, created: true };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await executeTransaction();
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          fuelData.client_submission_id
        ) {
          const existing = await this.findBySubmissionId(
            fuelData.businessId,
            fuelData.client_submission_id,
          );

          if (existing) return { fuel: existing, created: false };
        }

        const shouldRetry =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034" &&
          attempt < 2;

        if (!shouldRetry) throw error;
      }
    }

    throw new Error("Could not complete fuel transaction");
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
      ...buildSearchOr(orConditions),
    };

    const [fuelData, total] = await Promise.all([
      this.prisma.fuel.findMany({
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
      }),
      this.prisma.fuel.count({
        where: whereCondition,
      }),
    ]);

    return {
      data: fuelData,
      total,
    };
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

  async updateFuelAndMileage(
    { fuelData, fuelId }: UpdateFuel,
    mileageUpdate?: {
      businessId: string;
      vehicleId: string;
      currentMileage: number;
    },
  ): Promise<Fuel> {
    return this.prisma.$transaction(
      async (transaction) => {
        if (mileageUpdate) {
          const updatedMileage = await transaction.vehicle.updateMany({
            where: {
              id: mileageUpdate.vehicleId,
              businessId: mileageUpdate.businessId,
              current_mileage: { lt: mileageUpdate.currentMileage },
            },
            data: { current_mileage: mileageUpdate.currentMileage },
          });

          if (updatedMileage.count !== 1) {
            throw new VehicleMileageInvalidError();
          }
        }

        const filteredData = Object.fromEntries(
          Object.entries(fuelData).filter(([, value]) => value !== undefined),
        );

        if (filteredData.liters_amount || filteredData.price_per_liter) {
          const currentFuel = await transaction.fuel.findUnique({
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

        return transaction.fuel.update({
          where: { id: fuelId },
          data: filteredData,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
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

  async *streamFuelsForExport(
    businessId: string,
    userRole: string,
    search?: string,
  ): AsyncGenerator<any> {
    const normalizedSearch = search ? search.trim().toLowerCase() : "";
    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { notes: { contains: normalizedSearch, mode: "insensitive" } },
        ...(userRole === "MASTER"
          ? [
              {
                businessId: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
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
              { id: { contains: normalizedSearch, mode: "insensitive" } },
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
              { id: { contains: normalizedSearch, mode: "insensitive" } },
              { name: { contains: normalizedSearch, mode: "insensitive" } },
              { cnh: { contains: normalizedSearch, mode: "insensitive" } },
            ],
          },
        },
        {
          fuelType: {
            OR: [
              { id: { contains: normalizedSearch, mode: "insensitive" } },
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
      ...(userRole !== "MASTER" && { businessId }),
      ...buildSearchOr(orConditions),
    };

    const batchSize = 1000;
    let cursor: string | undefined = undefined;

    while (true) {
      const fuels: any = await this.prisma.fuel.findMany({
        where: whereCondition,
        include: {
          business: {
            select: { corporate_reason: true },
          },
          branch: {
            select: { corporate_reason: true },
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
          id: "asc",
        },
        take: batchSize,
        ...(cursor && {
          skip: 1,
          cursor: { id: cursor },
        }),
      });

      if (fuels.length === 0) break;
      for (const fuel of fuels) {
        yield {
          id: fuel.id,
          vehicleLicensePlate: fuel.vehicle?.license_plate,
          vehicleDescription: fuel.vehicle?.description,
          vehicleBrand: fuel.vehicle?.brand,
          vehicleModel: fuel.vehicle?.model,
          driverName: fuel.driver?.name,
          driverCnh: fuel.driver?.cnh,
          fuelTypeDescription: fuel.fuelType?.description,
          litersAmount: fuel.liters_amount,
          pricePerLiter: fuel.price_per_liter?.toNumber(),
          totalAmount: fuel.total_amount?.toNumber(),
          currentMileage: fuel.current_mileage,
          odometerVerified: fuel.odometer_verified,
          notes: fuel.notes,
          refueling_date: fuel.refueling_date,
          branchName: fuel.branch?.corporate_reason,
          ...(userRole === "MASTER" && {
            businessName: fuel.business?.corporate_reason,
          }),
          // 📍 GEOLOCATION: Proper null handling to avoid Number(null) = 0 issue
          latitude: fuel.latitude,
          longitude: fuel.longitude,
          latitude_original: fuel.latitude_original,
          longitude_original: fuel.longitude_original,
          location_source: fuel.location_source,
          location_edited_by: fuel.location_edited_by,
          location_edited_at: fuel.location_edited_at,
          created_from: fuel.created_from,
          created_at: fuel.created_at,
          updated_at: fuel.updated_at,
        };
      }

      cursor = fuels[fuels.length - 1].id;
    }
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

  async searchFuelByVehicleWithCursor({
    limit = 10,
    cursor,
    vehicleId,
    businessId,
  }: SearchFuelByVehicleWithCursorProps): Promise<CursorPaginatedFuel> {
    const items = await this.prisma.fuel.findMany({
      where: { vehicleId, businessId },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { created_at: "desc" },
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
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countFuelForExport(
    businessId: string,
    userRole: string,
  ): Promise<number> {
    const whereCondition: any = {
      ...(userRole !== "MASTER" && { businessId }),
    };

    const fuelsCount = await this.prisma.fuel.count({
      where: whereCondition,
    });

    return fuelsCount;
  }
}

export { FuelRepository };
