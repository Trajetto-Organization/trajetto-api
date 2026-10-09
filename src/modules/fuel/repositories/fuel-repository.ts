import database from "@/../infra/database";

import { Decimal } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client";
import type {
  FuelMileageUpdate,
  FuelPlacement,
  IFuelRepository,
} from "./IFuel-repository";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import {
  odometerTimeline,
  recordDate,
  releaseOdometer,
  type OdometerTimelineQuery,
} from "@/shared/vehicle/odometer-timeline";
import { resolveTimeZone } from "@/shared/time/business-day";
import { FuelNotFoundError } from "../usecases/errors/fuel-not-found-error";
import { placeReading } from "../usecases/fuel-rules";

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

import { resolveOrderBy } from "@/shared/pagination/list-query";

import {
  FUEL_SORT,
  fuelListWhere,
  fuelSearchWhere,
  labelIdsOf,
  type FuelListFilters,
  type FuelListGroup,
} from "../usecases/list-fuel/fuel-list";

/** What a list row carries of its relations (the export reads the same). */
const FUEL_LIST_INCLUDE = {
  branch: { select: { corporate_reason: true } },
  vehicle: {
    select: {
      description: true,
      license_plate: true,
      brand: true,
      model: true,
    },
  },
  driver: { select: { name: true, cnh: true } },
  fuelType: { select: { description: true } },
} as const;

interface ReadingWrite extends OdometerTimelineQuery {
  mileage: number;
  previousMileage: number | null;
}

/**
 * Places a refueling's km on its vehicle (placeReading) and writes the
 * odometer it ends with, conditional on the value read: a concurrent change
 * aborts the serializable transaction (P2034) and the caller retries.
 */
async function placeOnVehicle(
  tx: Prisma.TransactionClient,
  { mileage, previousMileage, ...query }: ReadingWrite,
): Promise<void> {
  const vehicle = await tx.vehicle.findFirst({
    where: { id: query.vehicleId, businessId: query.businessId },
    select: { current_mileage: true, last_maintenance_mileage: true },
  });

  if (!vehicle) throw new VehicleNotFoundError();

  const placement = placeReading({
    mileage,
    ...(await odometerTimeline(tx, query)),
    odometer: vehicle.current_mileage,
    maintenanceFloor: vehicle.last_maintenance_mileage,
    previousMileage,
  });

  if (!placement.fits) throw new VehicleMileageInvalidError();

  if (placement.odometer === null) return;

  const moved = await tx.vehicle.updateMany({
    where: {
      id: query.vehicleId,
      businessId: query.businessId,
      current_mileage: vehicle.current_mileage,
    },
    data: { current_mileage: placement.odometer },
  });

  if (moved.count !== 1) throw new VehicleMileageInvalidError();
}

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
    placement?: FuelPlacement,
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

          // Placed by its date before any odometer move (placeReading): the
          // forward rule used to run first, so a past refueling typed above
          // the later ones moved the odometer and froze the vehicle.
          await placeOnVehicle(transaction, {
            businessId: fuelData.businessId,
            vehicleId: fuelData.vehicleId,
            at: recordDate(fuelData.refueling_date),
            timeZone: resolveTimeZone(placement?.timeZone),
            mileage: fuelData.current_mileage,
            previousMileage: null,
          });

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
    sort,
    order,
    ...filters
  }: ListFuelByBusinessIdProps): Promise<ListFuelProps> {
    // Two queries side by side, never more (connection budget): the page and
    // one GROUP BY over the base that yields the pager, the cards and every
    // filter's options (fuel-list.ts). Names come after, inside the company.
    const [data, grouped] = await Promise.all([
      this.prisma.fuel.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: fuelListWhere(filters, { withFacets: true }),
        orderBy: resolveOrderBy(FUEL_SORT, { sort, order }),
        include: FUEL_LIST_INCLUDE,
      }),
      this.prisma.fuel.groupBy({
        by: ["branchId", "vehicleId", "fuelTypeId", "odometer_verified"],
        where: fuelListWhere(filters, { withFacets: false }),
        _count: { _all: true },
        _sum: { liters_amount: true, total_amount: true },
      }),
    ]);

    const groups: FuelListGroup[] = grouped.map((group) => ({
      branchId: group.branchId,
      vehicleId: group.vehicleId,
      fuelTypeId: group.fuelTypeId,
      odometer_verified: group.odometer_verified,
      count: group._count._all,
      liters: (group._sum.liters_amount ?? new Decimal(0)).toString(),
      amount: (group._sum.total_amount ?? new Decimal(0)).toString(),
    }));

    const ids = labelIdsOf(groups, filters);
    const { businessId } = filters;

    // `businessId` in every where: an id of another company typed into the
    // URL gets no name back.
    const branches = ids.branchId.length
      ? await this.prisma.branch.findMany({
          where: { businessId, id: { in: ids.branchId } },
          select: { id: true, corporate_reason: true },
        })
      : [];

    const vehicles = ids.vehicleId.length
      ? await this.prisma.vehicle.findMany({
          where: { businessId, id: { in: ids.vehicleId } },
          select: { id: true, license_plate: true },
        })
      : [];

    const fuelTypes = ids.fuelTypeId.length
      ? await this.prisma.fuelType.findMany({
          where: { businessId, id: { in: ids.fuelTypeId } },
          select: { id: true, description: true },
        })
      : [];

    return {
      data,
      groups,
      labels: {
        branchId: Object.fromEntries(
          branches.map((branch) => [branch.id, branch.corporate_reason]),
        ),
        vehicleId: Object.fromEntries(
          vehicles.map((vehicle) => [vehicle.id, vehicle.license_plate]),
        ),
        fuelTypeId: Object.fromEntries(
          fuelTypes.map((fuelType) => [fuelType.id, fuelType.description]),
        ),
      },
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
    mileageUpdate?: FuelMileageUpdate,
  ): Promise<Fuel> {
    return this.serializable(async (transaction) => {
      if (mileageUpdate) {
        const { businessId, vehicleId } = mileageUpdate;
        const excludeFuelId = mileageUpdate.fuelId ?? fuelId;

        const stored = await transaction.fuel.findFirst({
          where: { id: fuelId, businessId },
          select: { vehicleId: true, current_mileage: true },
        });

        if (!stored) throw new FuelNotFoundError();

        const sameVehicle = stored.vehicleId === vehicleId;

        // The km at its (new) date on the vehicle it ends on, a date-only
        // edit included: moving a reading before a lower one broke the order
        // every later check relies on.
        await placeOnVehicle(transaction, {
          businessId,
          vehicleId,
          at: mileageUpdate.at,
          timeZone: resolveTimeZone(mileageUpdate.timeZone),
          excludeFuelId,
          mileage: mileageUpdate.currentMileage,
          previousMileage: sameVehicle ? stored.current_mileage : null,
        });

        // Entered on the wrong truck, usually with the other truck's km:
        // the truck it leaves must not keep that km as its odometer.
        if (!sameVehicle) {
          await releaseOdometer(transaction, {
            businessId,
            vehicleId: stored.vehicleId,
            leaving: stored.current_mileage,
            excludeFuelId,
          });
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
    });
  }

  /**
   * One serializable transaction, retried on P2034: the timeline reads widen
   * the read set, so a refueling or checklist committed meanwhile aborts it,
   * and a fresh attempt sees that record. Same budget as the create.
   */
  private async serializable<T>(
    work: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034" &&
          attempt < 2;

        if (!retryable) throw error;
      }
    }
  }

  async deleteFuel(fuelId: string): Promise<Fuel> {
    return this.serializable(async (transaction) => {
      const deletedFuel = await transaction.fuel.delete({
        where: { id: fuelId },
      });

      // A refueling that set the odometer takes its km with it.
      await releaseOdometer(transaction, {
        businessId: deletedFuel.businessId,
        vehicleId: deletedFuel.vehicleId,
        leaving: deletedFuel.current_mileage,
        excludeFuelId: deletedFuel.id,
      });

      return deletedFuel;
    });
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

  async *streamFuelsForExport(
    filters: FuelListFilters,
  ): AsyncGenerator<any> {
    // The list's own where (decision 5.8): the file holds what the screen
    // filtered, never the whole company behind the operator's back.
    const whereCondition = fuelListWhere(filters, { withFacets: true });

    const batchSize = 1000;
    let cursor: string | undefined = undefined;

    // Keyset batches by id: a large export never pays for a growing OFFSET.
    while (true) {
      const fuels: any = await this.prisma.fuel.findMany({
        where: whereCondition,
        include: {
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
        orderBy: { id: "asc" },
        take: batchSize,
        ...(cursor && { skip: 1, cursor: { id: cursor } }),
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

      if (fuels.length < batchSize) break;

      cursor = fuels[fuels.length - 1].id;
    }
  }

  async getPreviousFuelByVehicleId(
    vehicleId: string,
    currentFuelDate: Date | string,
    businessId: string,
  ): Promise<Fuel | null> {
    const previousFuel = await this.prisma.fuel.findFirst({
      where: {
        vehicleId,
        businessId,
        refueling_date: {
          lt: new Date(currentFuelDate),
        },
      },
      // The later record, then the id, break a same-moment tie: without them
      // Postgres returned either of two refuelings typed for the same time.
      orderBy: [{ refueling_date: "desc" }, { created_at: "desc" }, { id: "desc" }],
    });

    return previousFuel;
  }

  async searchFuelByVehicleWithCursor({
    limit = 10,
    cursor,
    vehicleId,
    businessId,
    search,
    driverId,
  }: SearchFuelByVehicleWithCursorProps): Promise<CursorPaginatedFuel> {
    const term = search?.trim() ?? "";

    const items = await this.prisma.fuel.findMany({
      where: {
        vehicleId,
        businessId,
        ...(driverId && { driverId }),
        ...(term && { AND: [fuelSearchWhere(term)] }),
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      // The id breaks created_at ties: without it two refuelings saved in
      // the same millisecond could swap between pages and one repeat.
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
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

  async countFuelForExport(filters: FuelListFilters): Promise<number> {
    return this.prisma.fuel.count({
      where: fuelListWhere(filters, { withFacets: true }),
    });
  }

  async countFuelsByVehicleId(vehicleId: string): Promise<number> {
    return this.prisma.fuel.count({ where: { vehicleId } });
  }

  async countFuelsByDriverId(driverId: string): Promise<number> {
    return this.prisma.fuel.count({ where: { driverId } });
  }
}

export { FuelRepository };
