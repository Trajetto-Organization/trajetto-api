import { afterCursor, newestFirst } from "@/shared/in-memory/cursor";
import {
  recordNotFound,
  uniqueViolation,
} from "@/shared/in-memory/prisma-errors";
import { v7 as uuidV7 } from "uuid";
import { FUEL_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import { Decimal } from "@prisma/client/runtime/library";
import type {
  FuelMileageUpdate,
  FuelPlacement,
  IFuelRepository,
} from "../IFuel-repository";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";
import type { OdometerNeighbours } from "@/shared/vehicle/odometer-timeline";
import { resolveTimeZone } from "@/shared/time/business-day";
import {
  endOfBusinessDay,
  placeReading,
  releasedOdometer,
} from "../../usecases/fuel-rules";

import { FuelNotFoundError } from "../../usecases/errors/fuel-not-found-error";

import {
  Fuel,
  CreateFuelProps,
  ListFuelProps,
  ListFuelByBusinessIdProps,
  UpdateFuel,
  GetFuelByIdAndBusinessProps,
  SearchFuelByVehicleWithCursorProps,
  CursorPaginatedFuel,
} from "../../dtos/fuel-dto";

import { resolveOrderBy, type SortOrder } from "@/shared/pagination/list-query";
import {
  compareForOrder,
  type OrderValue,
} from "@/shared/pagination/in-memory-order";
import {
  FUEL_FACETS,
  FUEL_SORT,
  labelIdsOf,
  selectedOf,
  type FuelListFilters,
  type FuelListGroup,
} from "../../usecases/list-fuel/fuel-list";
import { compareExportKeys } from "@/shared/pagination/export-keyset";

/**
 * litres × price as the column keeps it: Fuel.total_amount is
 * Decimal(10, 2), and Postgres rounds half away from zero on the way in. The
 * twin kept up to six decimals (45,237 × 5,899 = 266,853063 against 266,85
 * stored), so its cards and export totals drifted from the database's.
 */
function storedTotal(
  liters: number | string | Decimal,
  price: number | string | Decimal,
): Decimal {
  return new Decimal(liters.toString())
    .mul(new Decimal(price.toString()))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Litres and price per litre are Decimal(10, 3). */
function storedThreePlaces(value: number | string | Decimal): Decimal {
  return new Decimal(value.toString()).toDecimalPlaces(
    3,
    Decimal.ROUND_HALF_UP,
  );
}

class InMemoryFuelRepository implements IFuelRepository {
  public fuels: Fuel[] = [];

  /**
   * Vehicles' odometers, for the mileage rule. A vehicle not seeded here is
   * not checked (the tests that do not care about mileage).
   */
  public vehicleMileage: Record<string, number> = {};

  /** Vehicles' last maintenance km (Vehicle.last_maintenance_mileage). */
  public vehicleMaintenanceMileage: Record<string, number> = {};

  /**
   * The readings around `at` — this twin knows refuelings only — with one
   * refueling left out, as odometerNeighbours reads them.
   */
  private neighboursOf(
    { businessId, vehicleId }: { businessId: string; vehicleId: string },
    at: Date,
    excludeFuelId?: string,
  ): OdometerNeighbours {
    const around = this.fuels.filter(
      (fuel) =>
        fuel.businessId === businessId &&
        fuel.vehicleId === vehicleId &&
        fuel.id !== excludeFuelId,
    );
    const instant = at.getTime();
    const before = around
      .filter((fuel) => new Date(fuel.refueling_date).getTime() <= instant)
      .map((fuel) => fuel.current_mileage);
    const after = around
      .filter((fuel) => new Date(fuel.refueling_date).getTime() > instant)
      .map((fuel) => fuel.current_mileage);

    return {
      before: before.length > 0 ? Math.max(...before) : null,
      after: after.length > 0 ? Math.min(...after) : null,
    };
  }

  /** The highest reading of a vehicle, one refueling left out. */
  private highestOf(
    vehicle: { businessId: string; vehicleId: string },
    excludeFuelId?: string,
  ): number | null {
    return this.neighboursOf(vehicle, new Date(8.64e15), excludeFuelId).before;
  }

  /**
   * The repository's placeOnVehicle: placeReading over the same inputs
   * (the day's end in the company's zone included), then the odometer.
   */
  private place(
    update: FuelMileageUpdate,
    previousMileage: number | null,
    excludeFuelId?: string,
  ): void {
    const odometer = this.vehicleMileage[update.vehicleId];

    if (odometer === undefined) return;

    const neighbours = this.neighboursOf(update, update.at, excludeFuelId);
    const restOfDay = this.neighboursOf(
      update,
      endOfBusinessDay(update.at, resolveTimeZone(update.timeZone)),
      excludeFuelId,
    );

    const placement = placeReading({
      mileage: update.currentMileage,
      neighbours,
      laterDay: neighbours.after === null ? null : restOfDay.after,
      highest: this.highestOf(update, excludeFuelId),
      odometer,
      maintenanceFloor:
        this.vehicleMaintenanceMileage[update.vehicleId] ?? null,
      previousMileage,
    });

    if (!placement.fits) throw new VehicleMileageInvalidError();

    if (placement.odometer !== null) {
      this.vehicleMileage[update.vehicleId] = placement.odometer;
    }
  }

  /** The repository's releaseOdometer, over refuelings. */
  private release(
    vehicle: { businessId: string; vehicleId: string },
    leaving: number,
    excludeFuelId: string,
  ): void {
    const odometer = this.vehicleMileage[vehicle.vehicleId];

    if (odometer === undefined || odometer !== leaving) return;

    const next = releasedOdometer(
      [this.highestOf(vehicle, excludeFuelId)],
      this.vehicleMaintenanceMileage[vehicle.vehicleId] ?? null,
    );

    if (next !== null && next < odometer) {
      this.vehicleMileage[vehicle.vehicleId] = next;
    }
  }

  async createFuel(fuelData: CreateFuelProps): Promise<Fuel> {
    // @@unique([businessId, client_submission_id]): the twin used to store a
    // second refueling under a key the database refuses with P2002.
    if (
      fuelData.client_submission_id &&
      this.fuels.some(
        (fuel) =>
          fuel.businessId === fuelData.businessId &&
          fuel.client_submission_id === fuelData.client_submission_id,
      )
    ) {
      throw uniqueViolation(["businessId", "client_submission_id"]);
    }

    // `??`, not `||`: the repository writes what it is given, so an empty
    // note stays "" and a coordinate of 0 stays 0, where `||` made both null.
    const newFuel: Fuel = {
      ...FUEL_COLUMN_DEFAULTS,
      id: uuidV7(),
      client_submission_id: fuelData.client_submission_id ?? null,
      current_mileage: fuelData.current_mileage,
      liters_amount: storedThreePlaces(fuelData.liters_amount),
      price_per_liter: storedThreePlaces(fuelData.price_per_liter),
      total_amount: storedTotal(
        fuelData.liters_amount,
        fuelData.price_per_liter,
      ),
      odometer_photo: fuelData.odometer_photo ?? null,
      odometer_verified: fuelData.odometer_verified ?? false,
      notes: fuelData.notes ?? null,
      refueling_date: fuelData.refueling_date,
      businessId: fuelData.businessId,
      branchId: fuelData.branchId as string,
      vehicleId: fuelData.vehicleId,
      driverId: fuelData.driverId as string,
      fuelTypeId: fuelData.fuelTypeId,
      // Geolocation fields
      latitude: fuelData.latitude ?? null,
      longitude: fuelData.longitude ?? null,
      latitude_original: fuelData.latitude_original ?? null,
      longitude_original: fuelData.longitude_original ?? null,
      location_source: fuelData.location_source ?? null,
      // The column default, as Postgres writes it.
      odometer_ai_status: "pending",
      created_from: fuelData.created_from,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.fuels.push(newFuel);
    return newFuel;
  }

  async findBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<Fuel | null> {
    return (
      this.fuels.find(
        (fuel) =>
          fuel.businessId === businessId &&
          fuel.client_submission_id === clientSubmissionId,
      ) ?? null
    );
  }

  async createFuelWithMileage(
    fuelData: CreateFuelProps,
    _afterCreate?: unknown,
    placement?: FuelPlacement,
  ): Promise<{ fuel: Fuel; created: boolean }> {
    if (fuelData.client_submission_id) {
      const existing = await this.findBySubmissionId(
        fuelData.businessId,
        fuelData.client_submission_id,
      );
      if (existing) return { fuel: existing, created: false };
    }

    this.place(
      {
        businessId: fuelData.businessId,
        vehicleId: fuelData.vehicleId,
        currentMileage: fuelData.current_mileage,
        at: fuelData.refueling_date
          ? new Date(fuelData.refueling_date)
          : new Date(),
        timeZone: placement?.timeZone,
      },
      null,
    );

    return { fuel: await this.createFuel(fuelData), created: true };
  }

  async listFuels({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListFuelByBusinessIdProps): Promise<ListFuelProps> {
    const base = this.fuels.filter((fuel) => this.matchesBase(fuel, filters));

    const orderBy = resolveOrderBy(FUEL_SORT, { sort, order });

    const sorted = base
      .filter((fuel) => this.matchesFacets(fuel, filters))
      .sort((a, b) => {
        for (const entry of orderBy) {
          const result = this.compareBy(entry as Record<string, unknown>, a, b);

          if (result !== 0) return result;
        }

        return 0;
      });

    const skip = (page - 1) * pageSize;

    const groups = new Map<string, FuelListGroup>();

    for (const fuel of base) {
      const key = [
        fuel.branchId,
        fuel.vehicleId,
        fuel.fuelTypeId,
        fuel.odometer_verified,
      ].join("|");

      const group = groups.get(key) ?? {
        branchId: fuel.branchId,
        vehicleId: fuel.vehicleId,
        fuelTypeId: fuel.fuelTypeId,
        odometer_verified: fuel.odometer_verified,
        count: 0,
        liters: "0",
        amount: "0",
      };

      group.count += 1;
      group.liters = new Decimal(group.liters)
        .plus(new Decimal(fuel.liters_amount.toString()))
        .toString();
      group.amount = new Decimal(group.amount)
        .plus(new Decimal(fuel.total_amount.toString()))
        .toString();

      groups.set(key, group);
    }

    const groupList = Array.from(groups.values());
    const ids = labelIdsOf(groupList, filters);

    // Same scoping as the repository: only the company's own catalog names.
    const labelsOf = (
      catalog: Map<string, { businessId: string; label: string }>,
      wanted: string[],
    ): Record<string, string> =>
      Object.fromEntries(
        wanted.flatMap((id) => {
          const row = catalog.get(id);

          return row && row.businessId === filters.businessId
            ? [[id, row.label]]
            : [];
        }),
      );

    return {
      data: sorted
        .slice(skip, skip + pageSize)
        .map((fuel) => this.withListRelations(fuel)) as any[],
      groups: groupList,
      labels: {
        branchId: labelsOf(this.branchLabels(), ids.branchId),
        vehicleId: labelsOf(this.vehicleLabels(), ids.vehicleId),
        fuelTypeId: labelsOf(this.fuelTypeLabels(), ids.fuelTypeId),
      },
    };
  }

  /**
   * Relation rows the list reads through joins. Tests seed them so search,
   * sorting and labels behave as they do over Postgres.
   */
  public branches = new Map<
    string,
    { businessId: string; corporate_reason: string }
  >();

  public vehicles = new Map<
    string,
    {
      businessId: string;
      license_plate: string;
      description: string;
      brand: string;
      model: string;
    }
  >();

  public drivers = new Map<string, { name: string; cnh: string }>();

  public fuelTypes = new Map<
    string,
    { businessId: string; description: string }
  >();

  private branchLabels(): Map<string, { businessId: string; label: string }> {
    return new Map(
      Array.from(this.branches.entries()).map(([id, row]) => [
        id,
        { businessId: row.businessId, label: row.corporate_reason },
      ]),
    );
  }

  private vehicleLabels(): Map<string, { businessId: string; label: string }> {
    return new Map(
      Array.from(this.vehicles.entries()).map(([id, row]) => [
        id,
        { businessId: row.businessId, label: row.license_plate },
      ]),
    );
  }

  private fuelTypeLabels(): Map<string, { businessId: string; label: string }> {
    return new Map(
      Array.from(this.fuelTypes.entries()).map(([id, row]) => [
        id,
        { businessId: row.businessId, label: row.description },
      ]),
    );
  }

  private withListRelations(fuel: Fuel) {
    const vehicle = this.vehicles.get(fuel.vehicleId);
    const driver = this.drivers.get(fuel.driverId);

    return {
      ...fuel,
      branch: {
        corporate_reason:
          this.branches.get(fuel.branchId)?.corporate_reason ?? "",
      },
      vehicle: {
        description: vehicle?.description ?? "",
        license_plate: vehicle?.license_plate ?? "",
        brand: vehicle?.brand ?? "",
        model: vehicle?.model ?? "",
      },
      driver: { name: driver?.name ?? "", cnh: driver?.cnh ?? "" },
      fuelType: {
        description: this.fuelTypes.get(fuel.fuelTypeId)?.description ?? "",
      },
    };
  }

  /** Scope and search: what fuelListWhere puts in the base. */
  private matchesBase(fuel: Fuel, filters: FuelListFilters): boolean {
    if (fuel.businessId !== filters.businessId) return false;
    if (filters.driverId && fuel.driverId !== filters.driverId) return false;

    const term = filters.search?.trim().toLowerCase() ?? "";

    if (!term) return true;

    const row = this.withListRelations(fuel);

    // Literal substring, case-insensitive: the escaped ILIKE of Postgres.
    return [
      fuel.id,
      fuel.notes ?? "",
      row.vehicle.license_plate,
      row.vehicle.description,
      row.vehicle.brand,
      row.vehicle.model,
      row.driver.name,
      row.driver.cnh,
      row.fuelType.description,
      row.branch.corporate_reason,
    ].some((value) => value.toLowerCase().includes(term));
  }

  private matchesFacets(fuel: Fuel, filters: FuelListFilters): boolean {
    return FUEL_FACETS.every((facet) => {
      const selected = selectedOf(filters, facet);

      return !selected || selected.includes(fuel[facet]);
    });
  }

  /**
   * One `orderBy` entry of FUEL_SORT, applied to two rows, through the
   * shared comparator: code-point strings and Postgres' placement, where
   * `localeCompare` and a flipped sign had drifted from the database.
   */
  private compareBy(entry: Record<string, unknown>, a: Fuel, b: Fuel): number {
    const [field, spec] = Object.entries(entry)[0];
    const nested = spec !== null && typeof spec === "object";

    const read = (fuel: Fuel): OrderValue => {
      const row = this.withListRelations(fuel) as Record<string, any>;

      if (nested) {
        const [key] = Object.keys(spec as object);

        return row[field][key];
      }

      const value = row[field];

      if (value instanceof Decimal) return value.toNumber();
      if (field.endsWith("_at") || field === "refueling_date") {
        return new Date(value);
      }

      return value;
    };

    const order = (
      nested ? Object.values(spec as object)[0] : spec
    ) as SortOrder;

    return compareForOrder(read(a), read(b), order);
  }

  async updateFuel({ fuelData, fuelId }: UpdateFuel): Promise<Fuel> {
    const index = this.fuels.findIndex((fuel) => fuel.id === fuelId);

    if (index === -1) {
      throw recordNotFound("update");
    }

    // Only `undefined` means "not sent", as in the repository: a null clears
    // the column (notes, a removed location), which the twin used to ignore.
    const filteredData = Object.fromEntries(
      Object.entries(fuelData).filter(([, value]) => value !== undefined),
    );

    // Convert Decimal fields if they exist in the update
    const processedData = { ...filteredData };
    if (fuelData.liters_amount) {
      processedData.liters_amount = storedThreePlaces(fuelData.liters_amount);
    }
    if (fuelData.price_per_liter) {
      processedData.price_per_liter = storedThreePlaces(
        fuelData.price_per_liter,
      );
    }

    // Never a client total: recomputed from litres × price, like the
    // repository.
    if (processedData.liters_amount || processedData.price_per_liter) {
      const current = this.fuels[index];
      // The raw values sent, as the repository multiplies them before
      // Postgres rounds each column.
      const liters = fuelData.liters_amount ?? current.liters_amount;
      const price = fuelData.price_per_liter ?? current.price_per_liter;

      processedData.total_amount = storedTotal(liters, price);
    } else if (processedData.total_amount) {
      processedData.total_amount = new Decimal(
        processedData.total_amount.toString(),
      ).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }

    const updatedFuel: Fuel = {
      ...this.fuels[index],
      ...processedData,
      updated_at: new Date(),
    };

    this.fuels[index] = updatedFuel;
    return updatedFuel;
  }

  async updateFuelAndMileage(
    update: UpdateFuel,
    mileageUpdate?: FuelMileageUpdate,
  ): Promise<Fuel> {
    if (!this.fuels.some((fuel) => fuel.id === update.fuelId)) {
      throw new Error("Fuel not found");
    }

    if (mileageUpdate) {
      const excludeFuelId = mileageUpdate.fuelId ?? update.fuelId;
      const stored = this.fuels.find(
        (fuel) =>
          fuel.id === update.fuelId &&
          fuel.businessId === mileageUpdate.businessId,
      );

      if (!stored) throw new FuelNotFoundError();

      const sameVehicle = stored.vehicleId === mileageUpdate.vehicleId;

      this.place(
        mileageUpdate,
        sameVehicle ? stored.current_mileage : null,
        excludeFuelId,
      );

      if (!sameVehicle) {
        this.release(
          { businessId: stored.businessId, vehicleId: stored.vehicleId },
          stored.current_mileage,
          excludeFuelId,
        );
      }
    }

    return this.updateFuel(update);
  }

  async deleteFuel(fuelId: string): Promise<Fuel> {
    const index = this.fuels.findIndex((fuel) => fuel.id === fuelId);

    if (index === -1) {
      throw recordNotFound("delete");
    }

    const deletedFuel = this.fuels.splice(index, 1)[0];

    this.release(deletedFuel, deletedFuel.current_mileage, deletedFuel.id);

    return deletedFuel;
  }

  async findFuelById(fuelId: string): Promise<Fuel | null> {
    const found = this.fuels.find((fuel) => fuel.id === fuelId);
    return found || null;
  }

  async findFuelByIdWithRelations(fuelId: string): Promise<any | null> {
    const fuel = this.fuels.find((fuel) => fuel.id === fuelId);

    if (!fuel) {
      return null;
    }

    // Mock relations data for testing (raw data, same as Prisma includes)
    return {
      ...fuel,
      business: {
        id: fuel.businessId,
        corporate_reason: `Business ${fuel.businessId}`,
        fantasy_name: `Fantasy Business ${fuel.businessId}`,
      },
      branch: {
        id: fuel.branchId,
        corporate_reason: `Branch ${fuel.branchId}`,
        fantasy_name: `Fantasy Branch ${fuel.branchId}`,
      },
      vehicle: {
        id: fuel.vehicleId,
        description: `Vehicle ${fuel.vehicleId}`,
        license_plate: `ABC-${fuel.vehicleId.substring(0, 4)}`,
        brand: "Test Brand",
        model: "Test Model",
        current_mileage: fuel.current_mileage,
      },
      driver: {
        id: fuel.driverId,
        name: `Driver ${fuel.driverId}`,
        cnh: `CNH-${fuel.driverId.substring(0, 8)}`,
      },
      fuelType: {
        id: fuel.fuelTypeId,
        description: `Fuel Type ${fuel.fuelTypeId}`,
      },
    };
  }

  async getFuelByIdAndBusiness({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<Fuel | null> {
    const found = this.fuels.find(
      (fuel) => fuel.id === fuelId && fuel.businessId === businessId,
    );
    return found || null;
  }

  async getFuelByIdAndBusinessWithRelations({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<any | null> {
    const fuel = this.fuels.find(
      (fuel) => fuel.id === fuelId && fuel.businessId === businessId,
    );

    if (!fuel) {
      return null;
    }

    return this.findFuelByIdWithRelations(fuelId);
  }

  async getPreviousFuelByVehicleId(
    vehicleId: string,
    currentFuelDate: Date | string,
    businessId: string,
  ): Promise<Fuel | null> {
    const vehicleFuels = this.fuels.filter(
      (fuel) => fuel.vehicleId === vehicleId && fuel.businessId === businessId,
    );

    if (vehicleFuels.length === 0) {
      return null;
    }

    const currentDate = new Date(currentFuelDate);

    // Filter fuels that are before the current fuel date
    const previousFuels = vehicleFuels.filter((fuel) => {
      const fuelDate = new Date(fuel.refueling_date);
      return fuelDate < currentDate;
    });

    if (previousFuels.length === 0) {
      return null;
    }

    // Date descending, then the later record and the id, as the repository
    // orders: two refuelings typed for the same moment used to come back in
    // insertion order here and in any order in Postgres.
    previousFuels.sort(
      (a, b) =>
        compareForOrder(
          new Date(a.refueling_date),
          new Date(b.refueling_date),
          "desc",
        ) ||
        compareForOrder(
          new Date(a.created_at),
          new Date(b.created_at),
          "desc",
        ) ||
        compareForOrder(a.id, b.id, "desc"),
    );

    return previousFuels[0];
  }

  async searchFuelByVehicleWithCursor({
    limit = 10,
    cursor,
    vehicleId,
    businessId,
    search,
    driverId,
  }: SearchFuelByVehicleWithCursorProps): Promise<CursorPaginatedFuel> {
    // Newest first with the id breaking ties, like the repository.
    let filtered = this.fuels
      .filter(
        (fuel) =>
          fuel.vehicleId === vehicleId &&
          this.matchesBase(fuel, { businessId, search, driverId }),
      )
      .sort(
        (a, b) =>
          compareForOrder(
            new Date(a.created_at),
            new Date(b.created_at),
            "desc",
          ) || compareForOrder(a.id, b.id, "desc"),
      );

    // A cursor that names no row (deleted meanwhile, or made up) gives an
    // empty page, as Prisma's does — restarting from the top repeated the
    // whole history under a client that kept paging.
    // Prisma's cursor: positioned on the cursor ROW, skip 1; an unknown
    // cursor yields nothing (it used to restart the list from the top).
    filtered = afterCursor(filtered, this.fuels, cursor, newestFirst);

    const hasMore = filtered.length > limit;

    const data = filtered
      .slice(0, limit)
      .map((fuel) => this.withListRelations(fuel)) as any[];
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async *streamFuelsForExport(filters: FuelListFilters): AsyncGenerator<any> {
    const filtered = this.fuels
      .filter(
        (fuel) =>
          this.matchesBase(fuel, filters) && this.matchesFacets(fuel, filters),
      )
      // The real one's keyset: created_at, then id in code-point order.
      .sort(compareExportKeys);

    for (const fuel of filtered) {
      const row = this.withListRelations(fuel);

      yield {
        id: fuel.id,
        vehicleLicensePlate: row.vehicle.license_plate,
        vehicleDescription: row.vehicle.description,
        vehicleBrand: row.vehicle.brand,
        vehicleModel: row.vehicle.model,
        driverName: row.driver.name,
        driverCnh: row.driver.cnh,
        fuelTypeDescription: row.fuelType.description,
        litersAmount: fuel.liters_amount,
        pricePerLiter: Number(fuel.price_per_liter),
        totalAmount: Number(fuel.total_amount),
        currentMileage: fuel.current_mileage,
        odometerVerified: fuel.odometer_verified,
        notes: fuel.notes,
        refueling_date: fuel.refueling_date,
        branchName: row.branch.corporate_reason,
        latitude: fuel.latitude ?? null,
        longitude: fuel.longitude ?? null,
        latitude_original: fuel.latitude_original ?? null,
        longitude_original: fuel.longitude_original ?? null,
        location_source: fuel.location_source ?? null,
        location_edited_by: fuel.location_edited_by ?? null,
        location_edited_at: fuel.location_edited_at ?? null,
        created_from: fuel.created_from,
        created_at: fuel.created_at,
        updated_at: fuel.updated_at,
      };
    }
  }

  async countFuelForExport(filters: FuelListFilters): Promise<number> {
    return this.fuels.filter(
      (fuel) =>
        this.matchesBase(fuel, filters) && this.matchesFacets(fuel, filters),
    ).length;
  }

  async countFuelsByVehicleId(vehicleId: string): Promise<number> {
    return this.fuels.filter((fuel) => fuel.vehicleId === vehicleId).length;
  }

  async countFuelsByDriverId(driverId: string): Promise<number> {
    return this.fuels.filter((fuel) => fuel.driverId === driverId).length;
  }
}

export { InMemoryFuelRepository };
