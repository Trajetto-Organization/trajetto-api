import { recordNotFound } from "@/shared/in-memory/prisma-errors";
import { v7 as uuidV7 } from "uuid";
import { VEHICLE_CHECKLIST_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";
import {
  IVehicleChecklistRepository,
  type ChecklistMileageUpdate,
  type ChecklistPlacement,
} from "../IVehicle-checklist-repository";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";
import { editedReadingRefusal } from "@/modules/vehicle/usecases/errors/vehicle-mileage-out-of-order-error";
import { VehicleChecklistBusinessNotFoundError } from "../../usecases/errors/vehicle-checklist-business-not-found-error";
import {
  END_OF_TIME,
  type OdometerNeighbours,
  type OdometerTimeline,
} from "@/shared/vehicle/odometer-timeline";
import { placeReading } from "@/modules/fuel/usecases/fuel-rules";
import { businessDayRange, resolveTimeZone } from "@/shared/time/business-day";

import {
  VehicleChecklist,
  CreateVehicleChecklistProps,
  ListVehicleChecklistProps,
  ListVehicleChecklistByBusinessIdProps,
  UpdateVehicleChecklist,
  GetVehicleChecklistByIdAndBusinessProps,
} from "../../dtos/vehicle-checklist-dto";

import type { SortOrder } from "@/shared/pagination/list-query";
import { matchesIdSearch } from "@/shared/pagination/id-search";
import {
  CHECKLIST_CONDITIONS,
  CHECKLIST_SORT_FALLBACK,
  tallyConditions,
  type ChecklistFacet,
  type ChecklistListFilters,
  type ChecklistSortKey,
  type NamedCount,
} from "../../usecases/list-vehicle-checklist/checklist-list";

type Comparable = string | number | null | undefined;

/** Postgres order: NULLS LAST ascending, NULLS FIRST descending. */
function compareNullable(
  a: Comparable,
  b: Comparable,
  order: SortOrder,
): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;

  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    const nullsGreater = aNull ? 1 : -1;
    return order === "asc" ? nullsGreater : -nullsGreater;
  }

  const base = a < b ? -1 : a > b ? 1 : 0;

  return order === "asc" ? base : -base;
}

class InMemoryVehicleChecklistRepository
  implements IVehicleChecklistRepository
{
  public checklists: VehicleChecklist[] = [];

  /**
   * The rows behind the relations the real query joins, seeded by the tests
   * (the twin has no other tables). A missing entry reads as the NULL a LEFT
   * JOIN gives.
   */
  public vehicleInfo: Record<
    string,
    {
      license_plate: string;
      description: string;
      brand?: string;
      model?: string;
    }
  > = {};
  public driverNames: Record<string, string> = {};
  public branchNames: Record<string, string> = {};

  /**
   * The vehicles' odometers, seeded by the tests that exercise the mileage
   * rule (the twin has no vehicle table). An unseeded vehicle is not checked.
   * Fuelings live in another twin, so only this twin's checklists bound a
   * reading on the timeline.
   */
  public vehicleMileage: Record<string, number> = {};

  /** Vehicles' last maintenance km (Vehicle.last_maintenance_mileage). */
  public vehicleMaintenanceMileage: Record<string, number> = {};

  /** odometerNeighbours over this twin's checklists, one left out. */
  private neighboursOf(
    { businessId, vehicleId }: { businessId: string; vehicleId: string },
    at: Date,
    excludeChecklistId?: string,
  ): OdometerNeighbours {
    const around = this.checklists.filter(
      (checklist) =>
        checklist.businessId === businessId &&
        checklist.vehicleId === vehicleId &&
        checklist.id !== excludeChecklistId,
    );
    const instant = at.getTime();
    const before = around
      .filter(
        (checklist) => new Date(checklist.checklist_date).getTime() <= instant,
      )
      .map((checklist) => checklist.current_mileage);
    const after = around
      .filter(
        (checklist) => new Date(checklist.checklist_date).getTime() > instant,
      )
      .map((checklist) => checklist.current_mileage);

    return {
      before: before.length > 0 ? Math.max(...before) : null,
      after: after.length > 0 ? Math.min(...after) : null,
    };
  }

  /** odometerTimeline over this twin's checklists. */
  private timelineOf(
    update: ChecklistMileageUpdate,
    excludeChecklistId?: string,
  ): OdometerTimeline {
    const neighbours = this.neighboursOf(update, update.at, excludeChecklistId);
    const timeZone = resolveTimeZone(update.timeZone);
    const endOfDay = new Date(
      businessDayRange(update.at, timeZone).end.getTime() - 1,
    );
    const restOfDay = this.neighboursOf(update, endOfDay, excludeChecklistId);

    return {
      neighbours,
      laterDay: neighbours.after === null ? null : restOfDay.after,
      highest: this.neighboursOf(update, END_OF_TIME, excludeChecklistId)
        .before,
    };
  }

  /**
   * The create's transaction: the repository's placeReading, by date first.
   * Between the readings around `at` the vehicle stays; as the newest
   * reading it moves forward; above a later day's reading it is refused.
   */
  private applyMileage(update: ChecklistMileageUpdate): void {
    const current = this.vehicleMileage[update.vehicleId];

    if (current === undefined) return;

    const placed = placeReading({
      mileage: update.currentMileage,
      ...this.timelineOf(update),
      odometer: current,
      maintenanceFloor:
        this.vehicleMaintenanceMileage[update.vehicleId] ?? null,
      previousMileage: null,
    });

    if (!placed.fits) throw new VehicleMileageInvalidError();

    if (placed.odometer !== null) {
      this.vehicleMileage[update.vehicleId] = placed.odometer;
    }
  }

  /** The edit's transaction: the same placeReading as the repository. */
  private applyEditedMileage(
    update: ChecklistMileageUpdate,
    checklistId: string,
  ): void {
    const stored = this.checklists.find(
      (checklist) =>
        checklist.id === checklistId &&
        checklist.businessId === update.businessId,
    );

    if (!stored) throw new VehicleChecklistBusinessNotFoundError();

    const odometer = this.vehicleMileage[update.vehicleId];

    if (odometer !== undefined) {
      const timeline = this.timelineOf(
        update,
        update.checklistId ?? checklistId,
      );
      const previousMileage =
        stored.vehicleId === update.vehicleId ? stored.current_mileage : null;

      const placement = placeReading({
        mileage: update.currentMileage,
        ...timeline,
        odometer,
        maintenanceFloor:
          this.vehicleMaintenanceMileage[update.vehicleId] ?? null,
        previousMileage,
      });

      if (!placement.fits) {
        throw editedReadingRefusal(previousMileage !== null, timeline);
      }

      const nextOdometer =
        update.readingChanged === false ? null : placement.odometer;

      if (nextOdometer !== null)
        this.vehicleMileage[update.vehicleId] = nextOdometer;
    }

    if (stored.vehicleId !== update.vehicleId) {
      this.release(stored, checklistId);
    }
  }

  /** The repository's releaseOdometer, over this twin's checklists. */
  private release(leaving: VehicleChecklist, excludeChecklistId: string): void {
    const odometer = this.vehicleMileage[leaving.vehicleId];

    if (odometer === undefined || odometer !== leaving.current_mileage) return;

    const known = [
      this.neighboursOf(leaving, END_OF_TIME, excludeChecklistId).before,
      this.vehicleMaintenanceMileage[leaving.vehicleId] ?? null,
    ].filter((value): value is number => value !== null);

    if (known.length === 0) return;

    const next = Math.max(...known);

    if (next < odometer) this.vehicleMileage[leaving.vehicleId] = next;
  }

  async createVehicleChecklist(
    checklistData: CreateVehicleChecklistProps,
  ): Promise<VehicleChecklist> {
    const checklist: VehicleChecklist = {
      ...VEHICLE_CHECKLIST_COLUMN_DEFAULTS,
      id: uuidV7(),
      client_submission_id: checklistData.client_submission_id ?? null,
      current_mileage: checklistData.current_mileage,
      checklist_date: checklistData.checklist_date || new Date(),
      tires_condition: checklistData.tires_condition,
      headlights_working: checklistData.headlights_working,
      taillights_working: checklistData.taillights_working,
      turn_signals_working: checklistData.turn_signals_working,
      bumpers_condition: checklistData.bumpers_condition,
      windshield_condition: checklistData.windshield_condition,
      mirrors_condition: checklistData.mirrors_condition,
      seatbelts_working: checklistData.seatbelts_working,
      dashboard_working: checklistData.dashboard_working,
      steering_wheel_condition: checklistData.steering_wheel_condition,
      brakes_working: checklistData.brakes_working,
      clutch_working: checklistData.clutch_working,
      fuel_level_adequate: checklistData.fuel_level_adequate,
      oil_level_adequate: checklistData.oil_level_adequate,
      radiator_water_adequate: checklistData.radiator_water_adequate,
      brake_fluid_adequate: checklistData.brake_fluid_adequate,
      battery_condition: checklistData.battery_condition,
      driver_license_valid: checklistData.driver_license_valid,
      vehicle_documents_valid: checklistData.vehicle_documents_valid,
      insurance_valid: checklistData.insurance_valid,
      fire_extinguisher_valid: checklistData.fire_extinguisher_valid,
      warning_triangle_present: checklistData.warning_triangle_present,
      jack_present: checklistData.jack_present,
      spare_tire_condition: checklistData.spare_tire_condition,
      notes: checklistData.notes || null,
      photos: checklistData.photos || [],
      overall_condition: checklistData.overall_condition,
      businessId: checklistData.businessId,
      branchId: checklistData.branchId || "",
      vehicleId: checklistData.vehicleId,
      driverId: checklistData.driverId || "",
      ai_verification_status: "",
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.checklists.push(checklist);
    return checklist;
  }

  async findBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<VehicleChecklist | null> {
    return (
      this.checklists.find(
        (checklist) =>
          checklist.businessId === businessId &&
          checklist.client_submission_id === clientSubmissionId,
      ) ?? null
    );
  }

  async createVehicleChecklistWithMileage(
    checklistData: CreateVehicleChecklistProps,
    _afterCreate?: unknown,
    placement?: ChecklistPlacement,
  ): Promise<{ checklist: VehicleChecklist; created: boolean }> {
    if (checklistData.client_submission_id) {
      const existing = await this.findBySubmissionId(
        checklistData.businessId,
        checklistData.client_submission_id,
      );
      if (existing) return { checklist: existing, created: false };
    }

    this.applyMileage({
      businessId: checklistData.businessId,
      vehicleId: checklistData.vehicleId,
      currentMileage: checklistData.current_mileage,
      at: checklistData.checklist_date
        ? new Date(checklistData.checklist_date)
        : new Date(),
      timeZone: placement?.timeZone,
    });

    return {
      checklist: await this.createVehicleChecklist(checklistData),
      created: true,
    };
  }

  /** The same conditions as checklistListWhere, over the array. */
  private matches(
    checklist: VehicleChecklist,
    filters: ChecklistListFilters,
    except?: ChecklistFacet,
  ): boolean {
    if (checklist.businessId !== filters.businessId) return false;
    if (filters.driverId && checklist.driverId !== filters.driverId)
      return false;

    if (
      except !== "condition" &&
      filters.conditions?.length &&
      !(filters.conditions as string[]).includes(checklist.overall_condition)
    ) {
      return false;
    }

    if (
      except !== "branch" &&
      filters.branchIds?.length &&
      !filters.branchIds.includes(checklist.branchId)
    ) {
      return false;
    }

    if (
      except !== "vehicle" &&
      filters.vehicleIds?.length &&
      !filters.vehicleIds.includes(checklist.vehicleId)
    ) {
      return false;
    }

    const term = filters.search?.trim().toLowerCase() ?? "";

    if (!term) return true;

    if (matchesIdSearch(checklist.id, term)) return true;

    const vehicle = this.vehicleInfo[checklist.vehicleId];

    return [
      checklist.notes,
      vehicle?.description,
      vehicle?.license_plate,
      vehicle?.brand,
      vehicle?.model,
      this.driverNames[checklist.driverId],
      this.branchNames[checklist.branchId],
    ].some((value) => (value ?? "").toLowerCase().includes(term));
  }

  private sortValue(
    checklist: VehicleChecklist,
    key: ChecklistSortKey,
  ): Comparable {
    switch (key) {
      case "created_at":
      case "checklist_date":
        return new Date(checklist[key]).getTime();
      case "vehicle_license_plate":
        return this.vehicleInfo[checklist.vehicleId]?.license_plate;
      case "vehicle_description":
        return this.vehicleInfo[checklist.vehicleId]?.description;
      case "driver_name":
        return this.driverNames[checklist.driverId];
      case "branchName":
        return this.branchNames[checklist.branchId];
      default:
        return checklist[key];
    }
  }

  private namedCounts(
    base: VehicleChecklist[],
    idOf: (checklist: VehicleChecklist) => string,
    selected: string[] | undefined,
    nameOf: (id: string) => string | undefined,
  ): NamedCount[] {
    const ids = new Set<string>(selected ?? []);

    for (const checklist of base) ids.add(idOf(checklist));

    // Only names this company knows (the seeds), like the real lookup by id
    // AND businessId.
    return [...ids]
      .filter((id) => nameOf(id) !== undefined)
      .map((id) => ({
        id,
        name: nameOf(id) as string,
        count: base.filter((checklist) => idOf(checklist) === id).length,
      }));
  }

  async listVehicleChecklists({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListVehicleChecklistByBusinessIdProps): Promise<ListVehicleChecklistProps> {
    const key = sort ?? CHECKLIST_SORT_FALLBACK.sort;
    const direction = order ?? (sort ? "asc" : CHECKLIST_SORT_FALLBACK.order);

    const rows = this.checklists
      .filter((checklist) => this.matches(checklist, filters))
      .sort(
        (a, b) =>
          compareNullable(
            this.sortValue(a, key),
            this.sortValue(b, key),
            direction,
          ) ||
          compareNullable(
            new Date(a.created_at).getTime(),
            new Date(b.created_at).getTime(),
            "desc",
          ) ||
          compareNullable(a.id, b.id, "desc"),
      );

    const skip = (page - 1) * pageSize;

    const conditionBase = this.checklists.filter((checklist) =>
      this.matches(checklist, filters, "condition"),
    );

    const conditionCounts = tallyConditions(
      CHECKLIST_CONDITIONS.map((condition) => ({
        overall_condition: condition,
        _count: {
          _all: conditionBase.filter(
            (checklist) => checklist.overall_condition === condition,
          ).length,
        },
      })),
    );

    const vehicleLabel = (id: string) => {
      const vehicle = this.vehicleInfo[id];
      return vehicle
        ? `${vehicle.license_plate} — ${vehicle.description}`
        : undefined;
    };

    return {
      data: rows.slice(skip, skip + pageSize),
      conditionCounts,
      branchCounts: this.namedCounts(
        this.checklists.filter((checklist) =>
          this.matches(checklist, filters, "branch"),
        ),
        (checklist) => checklist.branchId,
        filters.branchIds,
        (id) => this.branchNames[id],
      ),
      vehicleCounts: this.namedCounts(
        this.checklists.filter((checklist) =>
          this.matches(checklist, filters, "vehicle"),
        ),
        (checklist) => checklist.vehicleId,
        filters.vehicleIds,
        vehicleLabel,
      ),
    };
  }

  async updateVehicleChecklist({
    checklistData,
    checklistId,
  }: UpdateVehicleChecklist): Promise<VehicleChecklist> {
    const index = this.checklists.findIndex(
      (checklist) => checklist.id === checklistId,
    );

    if (index === -1) {
      throw recordNotFound("update");
    }

    // Only undefined means "not sent", as in the Prisma update: a null (the
    // schema's cleared note) is written.
    const filteredData = Object.fromEntries(
      Object.entries(checklistData).filter(([, value]) => value !== undefined),
    );

    const updatedChecklist: VehicleChecklist = {
      ...this.checklists[index],
      ...filteredData,
      updated_at: new Date(),
    };

    this.checklists[index] = updatedChecklist;
    return updatedChecklist;
  }

  async updateVehicleChecklistAndMileage(
    update: UpdateVehicleChecklist,
    mileageUpdate?: ChecklistMileageUpdate,
  ): Promise<VehicleChecklist> {
    if (
      !this.checklists.some((checklist) => checklist.id === update.checklistId)
    ) {
      throw new Error("Checklist not found");
    }

    if (mileageUpdate)
      this.applyEditedMileage(mileageUpdate, update.checklistId);

    return this.updateVehicleChecklist(update);
  }

  async deleteVehicleChecklist(checklistId: string): Promise<VehicleChecklist> {
    const index = this.checklists.findIndex(
      (checklist) => checklist.id === checklistId,
    );

    if (index === -1) {
      throw new Error("Checklist not found");
    }

    const deletedChecklist = this.checklists.splice(index, 1)[0];

    // The repository releases the odometer the row set, in the same transaction.
    this.release(deletedChecklist, deletedChecklist.id);

    return deletedChecklist;
  }

  async findVehicleChecklistById(
    checklistId: string,
  ): Promise<VehicleChecklist | null> {
    const found = this.checklists.find(
      (checklist) => checklist.id === checklistId,
    );

    return found || null;
  }

  async getVehicleChecklistByIdAndBusiness({
    businessId,
    checklistId,
  }: GetVehicleChecklistByIdAndBusinessProps): Promise<VehicleChecklist | null> {
    const found = this.checklists.find(
      (checklist) =>
        checklist.id === checklistId && checklist.businessId === businessId,
    );

    return found || null;
  }

  async countVehicleChecklistsByDriverId(driverId: string): Promise<number> {
    return this.checklists.filter(
      (checklist) => checklist.driverId === driverId,
    ).length;
  }

  async *streamChecklistsForExport(
    filters: ChecklistListFilters,
  ): AsyncGenerator<Record<string, unknown>> {
    const rows = this.checklists
      .filter((checklist) => this.matches(checklist, filters))
      .sort((a, b) => compareNullable(a.id, b.id, "asc"));

    for (const checklist of rows) {
      const vehicle = this.vehicleInfo[checklist.vehicleId];

      yield {
        id: checklist.id,
        vehicleLicensePlate: vehicle?.license_plate ?? null,
        vehicleDescription: vehicle?.description ?? null,
        vehicleBrand: vehicle?.brand ?? null,
        vehicleModel: vehicle?.model ?? null,
        vehicleCurrentMileage: null,
        driverName: this.driverNames[checklist.driverId] ?? null,
        driverCnh: null,
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
        branchName: this.branchNames[checklist.branchId] ?? null,
        created_at: checklist.created_at,
        updated_at: checklist.updated_at,
      };
    }
  }

  async countChecklistForExport(
    filters: ChecklistListFilters,
  ): Promise<number> {
    return this.checklists.filter((checklist) =>
      this.matches(checklist, filters),
    ).length;
  }
}

export { InMemoryVehicleChecklistRepository };
