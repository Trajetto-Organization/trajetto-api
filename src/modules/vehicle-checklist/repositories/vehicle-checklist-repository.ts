import database from "@/../infra/database";
import { Prisma } from "@prisma/client";
import {
  IVehicleChecklistRepository,
  type ChecklistMileageUpdate,
  type ChecklistPlacement,
} from "./IVehicle-checklist-repository";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";
import { editedReadingRefusal } from "@/modules/vehicle/usecases/errors/vehicle-mileage-out-of-order-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleChecklistBusinessNotFoundError } from "../usecases/errors/vehicle-checklist-business-not-found-error";
import {
  odometerTimeline,
  recordDate,
  releaseOdometer,
} from "@/shared/vehicle/odometer-timeline";
// The fueling edit's placement: one timeline holds both kinds of record, so
// they are decided by one rule (to move into shared/vehicle, see notes).
import { placeReading } from "@/modules/fuel/usecases/fuel-rules";
import { resolveTimeZone } from "@/shared/time/business-day";
import { isSerializationFailure } from "@/shared/errors/prisma-error-meta";

import {
  VehicleChecklist,
  CreateVehicleChecklistProps,
  ListVehicleChecklistProps,
  ListVehicleChecklistByBusinessIdProps,
  UpdateVehicleChecklist,
  GetVehicleChecklistByIdAndBusinessProps,
} from "../dtos/vehicle-checklist-dto";

import { resolveOrderBy } from "@/shared/pagination/list-query";

import {
  CHECKLIST_SORT,
  checklistListWhere,
  tallyConditions,
  type ChecklistListFilters,
} from "../usecases/list-vehicle-checklist/checklist-list";

class VehicleChecklistRepository implements IVehicleChecklistRepository {
  constructor(private prisma = database) {}

  async createVehicleChecklist(
    checklistData: CreateVehicleChecklistProps,
  ): Promise<VehicleChecklist> {
    const checklistCreated = await this.prisma.vehicleChecklist.create({
      data: {
        ...checklistData,
        photos: checklistData.photos,
        branchId: checklistData.branchId!,
        driverId: checklistData.driverId!,
      },
    });

    return checklistCreated;
  }

  async findBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<VehicleChecklist | null> {
    return this.prisma.vehicleChecklist.findFirst({
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
  async createVehicleChecklistWithMileage(
    checklistData: CreateVehicleChecklistProps,
    afterCreate?: (
      tx: Prisma.TransactionClient,
      checklist: VehicleChecklist,
    ) => Promise<void>,
    placement?: ChecklistPlacement,
  ): Promise<{ checklist: VehicleChecklist; created: boolean }> {
    const executeTransaction = async () =>
      this.prisma.$transaction(
        async (transaction) => {
          if (checklistData.client_submission_id) {
            const existing = await transaction.vehicleChecklist.findFirst({
              where: {
                businessId: checklistData.businessId,
                client_submission_id: checklistData.client_submission_id,
              },
            });

            if (existing) {
              return { checklist: existing, created: false };
            }
          }

          // Placed by its date before any odometer move (placeReading, the
          // fueling create's rule; one timeline holds both). The forward rule
          // used to run first: a checklist dated days ago with its km typed
          // above the later readings moved the odometer, and every later
          // record of the truck was refused from then on. Between the
          // readings around its date it is stored and the vehicle stays;
          // as the newest reading it moves the odometer forward, as always.
          const vehicle = await transaction.vehicle.findFirst({
            where: {
              id: checklistData.vehicleId,
              businessId: checklistData.businessId,
            },
            select: { current_mileage: true, last_maintenance_mileage: true },
          });

          if (!vehicle) throw new VehicleMileageInvalidError();

          const placed = placeReading({
            mileage: checklistData.current_mileage,
            ...(await odometerTimeline(transaction, {
              businessId: checklistData.businessId,
              vehicleId: checklistData.vehicleId,
              at: recordDate(checklistData.checklist_date),
              timeZone: resolveTimeZone(placement?.timeZone),
            })),
            odometer: vehicle.current_mileage,
            maintenanceFloor: vehicle.last_maintenance_mileage,
            previousMileage: null,
          });

          if (!placed.fits) throw new VehicleMileageInvalidError();

          if (placed.odometer !== null) {
            // Conditional on the odometer read above: a concurrent change
            // aborts this serializable transaction (isSerializationFailure)
            // and the retry below decides again on what is stored then.
            const moved = await transaction.vehicle.updateMany({
              where: {
                id: checklistData.vehicleId,
                businessId: checklistData.businessId,
                current_mileage: vehicle.current_mileage,
              },
              data: { current_mileage: placed.odometer },
            });

            if (moved.count !== 1) throw new VehicleMileageInvalidError();
          }

          // `created_from` is accepted by the schema (the app stamps
          // MOBILE_APP) and read by the use case for the outbox event's
          // `origin`, but vehicle_checklist has no such column: spread into
          // the insert, it failed every checklist the app sent with a 500,
          // which the outbox then retried forever as a server error.
          const { created_from: _origin, ...row } = checklistData;

          const checklist = await transaction.vehicleChecklist.create({
            data: {
              ...row,
              photos: checklistData.photos,
              branchId: checklistData.branchId!,
              driverId: checklistData.driverId!,
            },
          });

          if (afterCreate) {
            await afterCreate(transaction, checklist);
          }

          return { checklist, created: true };
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
          checklistData.client_submission_id
        ) {
          const existing = await this.findBySubmissionId(
            checklistData.businessId,
            checklistData.client_submission_id,
          );

          if (existing) return { checklist: existing, created: false };
        }

        const shouldRetry = isSerializationFailure(error) && attempt < 2;

        if (!shouldRetry) throw error;
      }
    }

    throw new Error("Could not complete checklist transaction");
  }

  async listVehicleChecklists({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListVehicleChecklistByBusinessIdProps): Promise<ListVehicleChecklistProps> {
    // Two reads at a time at most (tests/E2E/connection-fan-out): the page
    // with the condition breakdown, then each id facet in turn.
    const [checklistsData, conditionGroups] = await Promise.all([
      this.prisma.vehicleChecklist.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: checklistListWhere(filters),
        include: {
          branch: {
            select: {
              corporate_reason: true,
              fantasy_name: true,
            },
          },
          vehicle: {
            select: {
              description: true,
              license_plate: true,
              brand: true,
              model: true,
              current_mileage: true,
            },
          },
          driver: {
            select: {
              name: true,
              cnh: true,
            },
          },
        },
        orderBy: resolveOrderBy(CHECKLIST_SORT, { sort, order }),
      }),
      // The cards come from the whole filter, never from the page: they used
      // to count "Condição boa" among the ten rows on screen.
      this.prisma.vehicleChecklist.groupBy({
        by: ["overall_condition"],
        where: checklistListWhere(filters, { except: "condition" }),
        _count: { _all: true },
      }),
    ]);

    const branchGroups = await this.prisma.vehicleChecklist.groupBy({
      by: ["branchId"],
      where: checklistListWhere(filters, { except: "branch" }),
      _count: { _all: true },
    });

    const vehicleGroups = await this.prisma.vehicleChecklist.groupBy({
      by: ["vehicleId"],
      where: checklistListWhere(filters, { except: "vehicle" }),
      _count: { _all: true },
    });

    const branchCount = new Map(
      branchGroups.map((group) => [group.branchId, group._count._all]),
    );
    const vehicleCount = new Map(
      vehicleGroups.map((group) => [group.vehicleId, group._count._all]),
    );

    // Named from THIS company only: an id of another company in the URL gets
    // neither a count nor a name. A selected option that matches nothing
    // stays listed with 0 so its chip keeps a name.
    const branchIds = [
      ...new Set([...branchCount.keys(), ...(filters.branchIds ?? [])]),
    ];
    const vehicleIds = [
      ...new Set([...vehicleCount.keys(), ...(filters.vehicleIds ?? [])]),
    ];

    const branches = branchIds.length
      ? await this.prisma.branch.findMany({
          where: { id: { in: branchIds }, businessId: filters.businessId },
          select: { id: true, corporate_reason: true },
        })
      : [];

    const vehicles = vehicleIds.length
      ? await this.prisma.vehicle.findMany({
          where: { id: { in: vehicleIds }, businessId: filters.businessId },
          select: { id: true, license_plate: true, description: true },
        })
      : [];

    return {
      data: checklistsData,
      conditionCounts: tallyConditions(conditionGroups),
      branchCounts: branches.map((branch) => ({
        id: branch.id,
        name: branch.corporate_reason,
        count: branchCount.get(branch.id) ?? 0,
      })),
      vehicleCounts: vehicles.map((vehicle) => ({
        id: vehicle.id,
        name: `${vehicle.license_plate} — ${vehicle.description}`,
        count: vehicleCount.get(vehicle.id) ?? 0,
      })),
    };
  }

  async updateVehicleChecklist({
    checklistData,
    checklistId,
  }: UpdateVehicleChecklist): Promise<VehicleChecklist> {
    // Filter out undefined values to prevent overwriting existing data with undefined
    const filteredData = Object.fromEntries(
      Object.entries(checklistData).filter(([_, value]) => value !== undefined),
    );

    const updatedChecklist = await this.prisma.vehicleChecklist.update({
      where: {
        id: checklistId,
      },
      data: filteredData,
    });

    return updatedChecklist;
  }

  async updateVehicleChecklistAndMileage(
    { checklistData, checklistId }: UpdateVehicleChecklist,
    mileageUpdate?: ChecklistMileageUpdate,
  ): Promise<VehicleChecklist> {
    return this.serializableWithRetry(async (transaction) => {
      if (mileageUpdate) {
        // The timeline decides before the odometer (placeReading, the
        // fueling edit's rule too: one timeline holds both). Trying "ahead
        // of the odometer" first let an older checklist jump above the ones
        // after it and drag the odometer along, and never let the newest
        // be corrected downwards.
        const { businessId, vehicleId, currentMileage } = mileageUpdate;

        // One after another: a transaction holds a single connection.
        const stored = await transaction.vehicleChecklist.findFirst({
          where: { id: checklistId, businessId },
          select: { vehicleId: true, current_mileage: true },
        });

        if (!stored) throw new VehicleChecklistBusinessNotFoundError();

        const vehicle = await transaction.vehicle.findFirst({
          where: { id: vehicleId, businessId },
          select: { current_mileage: true, last_maintenance_mileage: true },
        });

        if (!vehicle) throw new VehicleNotFoundError();

        const timeline = await odometerTimeline(transaction, {
          businessId,
          vehicleId,
          at: mileageUpdate.at,
          timeZone: resolveTimeZone(mileageUpdate.timeZone),
          excludeChecklistId: mileageUpdate.checklistId ?? checklistId,
        });

        const previousMileage =
          stored.vehicleId === vehicleId ? stored.current_mileage : null;

        const placement = placeReading({
          mileage: currentMileage,
          ...timeline,
          odometer: vehicle.current_mileage,
          maintenanceFloor: vehicle.last_maintenance_mileage,
          previousMileage,
        });

        if (!placement.fits) {
          throw editedReadingRefusal(previousMileage !== null, timeline);
        }

        // A date-only move re-checks the order and leaves the odometer as
        // it is: the reading was accepted once, and a MASTER's correction
        // of the vehicle since then must not be undone by a new date.
        const nextOdometer =
          mileageUpdate.readingChanged === false ? null : placement.odometer;

        if (nextOdometer !== null && nextOdometer !== vehicle.current_mileage) {
          // Conditional on the odometer read above: a concurrent change
          // aborts this serializable transaction (isSerializationFailure)
          // and the retry below decides again on what is stored then.
          const moved = await transaction.vehicle.updateMany({
            where: {
              id: vehicleId,
              businessId,
              current_mileage: vehicle.current_mileage,
            },
            data: { current_mileage: nextOdometer },
          });

          if (moved.count !== 1) throw new VehicleMileageInvalidError();
        }

        // Moved to another vehicle: when its reading set the odometer of
        // the one it leaves, that odometer goes back to the readings left.
        if (stored.vehicleId !== vehicleId) {
          await releaseOdometer(transaction, {
            businessId,
            vehicleId: stored.vehicleId,
            leaving: stored.current_mileage,
            excludeChecklistId: checklistId,
          });
        }
      }

      const filteredData = Object.fromEntries(
        Object.entries(checklistData).filter(
          ([, value]) => value !== undefined,
        ),
      );

      return transaction.vehicleChecklist.update({
        where: { id: checklistId },
        data: filteredData,
      });
    });
  }

  async deleteVehicleChecklist(checklistId: string): Promise<VehicleChecklist> {
    // The row and the odometer it may have set go together: deleting the
    // 150 000 typed for 15 000 left the vehicle at 150 000, and every later
    // fueling and checklist was refused until a MASTER edited the vehicle.
    return this.serializableWithRetry(async (transaction) => {
      const checklistToDelete = await transaction.vehicleChecklist.findUnique({
        where: { id: checklistId },
      });

      if (!checklistToDelete) {
        throw new Error("Checklist not found");
      }

      const deletedChecklist = await transaction.vehicleChecklist.delete({
        where: { id: checklistId },
      });

      await releaseOdometer(transaction, {
        businessId: deletedChecklist.businessId,
        vehicleId: deletedChecklist.vehicleId,
        leaving: deletedChecklist.current_mileage,
        excludeChecklistId: deletedChecklist.id,
      });

      return deletedChecklist;
    });
  }

  /**
   * A serializable transaction retried on a serialization failure
   * (isSerializationFailure: P2034, or the bare adapter error Prisma 7 throws
   * when the COMMIT is refused): the timeline reads widen the read set, so a
   * record committed meanwhile aborts it and a fresh attempt sees that
   * record. Same budget as the create.
   */
  private async serializableWithRetry<T>(
    work: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable = isSerializationFailure(error) && attempt < 2;

        if (!retryable) throw error;
      }
    }
  }

  async findVehicleChecklistById(
    checklistId: string,
  ): Promise<VehicleChecklist | null> {
    const checklist = await this.prisma.vehicleChecklist.findUnique({
      where: {
        id: checklistId,
      },
    });

    return checklist;
  }

  async getVehicleChecklistByIdAndBusiness({
    businessId,
    checklistId,
  }: GetVehicleChecklistByIdAndBusinessProps): Promise<VehicleChecklist | null> {
    const checklist = await this.prisma.vehicleChecklist.findFirst({
      where: {
        id: checklistId,
        businessId,
      },
    });

    return checklist;
  }

  async countVehicleChecklistsByDriverId(driverId: string): Promise<number> {
    return this.prisma.vehicleChecklist.count({ where: { driverId } });
  }

  async *streamChecklistsForExport(
    filters: ChecklistListFilters,
  ): AsyncGenerator<Record<string, unknown>> {
    const whereCondition = checklistListWhere(filters);

    const batchSize = 1000;
    let cursor: string | undefined = undefined;

    while (true) {
      const checklists: Array<
        VehicleChecklist & {
          branch: { corporate_reason: string } | null;
          vehicle: {
            description: string;
            license_plate: string;
            brand: string;
            model: string;
            current_mileage: number;
          } | null;
          driver: { name: string; cnh: string } | null;
        }
      > = await this.prisma.vehicleChecklist.findMany({
        where: whereCondition,
        include: {
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
              current_mileage: true,
            },
          },
          driver: {
            select: {
              name: true,
              cnh: true,
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

      if (checklists.length === 0) break;
      for (const checklist of checklists) {
        yield {
          id: checklist.id,
          vehicleLicensePlate: checklist.vehicle?.license_plate,
          vehicleDescription: checklist.vehicle?.description,
          vehicleBrand: checklist.vehicle?.brand,
          vehicleModel: checklist.vehicle?.model,
          vehicleCurrentMileage: checklist.vehicle?.current_mileage,
          driverName: checklist.driver?.name,
          driverCnh: checklist.driver?.cnh,
          checklist_date: checklist.checklist_date,
          current_mileage: checklist.current_mileage,
          tires_condition: checklist.tires_condition,
          headlights_working: checklist.headlights_working,
          taillights_working: checklist.taillights_working,
          turn_signals_working: checklist.turn_signals_working,
          bumpers_condition: checklist.bumpers_condition,
          windshield_condition: checklist.windshield_condition,
          mirrors_condition: checklist.mirrors_condition,
          seatbelts_working: checklist.seatbelts_working,
          dashboard_working: checklist.dashboard_working,
          steering_wheel_condition: checklist.steering_wheel_condition,
          brakes_working: checklist.brakes_working,
          clutch_working: checklist.clutch_working,
          fuel_level_adequate: checklist.fuel_level_adequate,
          oil_level_adequate: checklist.oil_level_adequate,
          radiator_water_adequate: checklist.radiator_water_adequate,
          brake_fluid_adequate: checklist.brake_fluid_adequate,
          battery_condition: checklist.battery_condition,
          driver_license_valid: checklist.driver_license_valid,
          vehicle_documents_valid: checklist.vehicle_documents_valid,
          insurance_valid: checklist.insurance_valid,
          fire_extinguisher_valid: checklist.fire_extinguisher_valid,
          warning_triangle_present: checklist.warning_triangle_present,
          jack_present: checklist.jack_present,
          spare_tire_condition: checklist.spare_tire_condition,
          overall_condition: checklist.overall_condition,
          notes: checklist.notes,
          branchName: checklist.branch?.corporate_reason,
          created_at: checklist.created_at,
          updated_at: checklist.updated_at,
        };
      }

      cursor = checklists[checklists.length - 1].id;
    }
  }

  async countChecklistForExport(
    filters: ChecklistListFilters,
  ): Promise<number> {
    return this.prisma.vehicleChecklist.count({
      where: checklistListWhere(filters),
    });
  }
}

export { VehicleChecklistRepository };
