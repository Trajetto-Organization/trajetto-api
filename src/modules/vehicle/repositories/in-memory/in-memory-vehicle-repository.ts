import {
  recordNotFound,
  uniqueViolation,
} from "@/shared/in-memory/prisma-errors";
import { afterCursor } from "@/shared/in-memory/cursor";
import { v7 as uuidV7 } from "uuid";
import { IVehicleRepository } from "../IVehicle-repository";
import {
  tallyStatuses,
  VEHICLE_STATUSES,
} from "@/shared/vehicle/vehicle-rules";

import {
  Vehicle,
  CreateVehicleProps,
  ListVehicleProps,
  ListVehicleByBusinessIdProps,
  UpdateVehicle,
  GetVehicleByIdAndBusinessProps,
  SearchVehicleWithCursorProps,
  CursorPaginatedVehicle,
  VehicleChoice,
  VehicleUsageCounts,
  VehicleStatusCounts,
} from "../../dtos/vehicle-dto";

import {
  canDriverOperateVehicle,
  type VehicleAssignment,
} from "@/shared/vehicle/driver-vehicle-access";
import type { OpenRouteCounts } from "@/shared/vehicle/vehicle-status-change";

import {
  VEHICLE_SORT_FALLBACK,
  type VehicleBranchCount,
  type VehicleFacet,
  type VehicleListFilters,
  type VehicleSortKey,
} from "../../usecases/list-vehicle/vehicle-list";
import type { SortOrder } from "@/shared/pagination/list-query";
import { compareExportKeys } from "@/shared/pagination/export-keyset";
import { matchesIdSearch } from "@/shared/pagination/id-search";

/** A route as the twin sees it: the route twin's rows fit this shape. */
type RouteRow = VehicleAssignment & { businessId: string };

/** enum VehicleStatus, in declaration order (schema.prisma). */
const VEHICLE_STATUS_ORDER = ["ACTIVE", "INACTIVE", "BLOCKED", "IN_ROUTE"];

type Comparable = string | number | Date | null | undefined;

/**
 * Postgres order: NULLs sort after every value ascending and before them
 * descending (its default NULLS LAST / NULLS FIRST), which is what the
 * relation sorts do for a vehicle with no driver, type or branch.
 */
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

  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  const base = left < right ? -1 : left > right ? 1 : 0;

  return order === "asc" ? base : -base;
}

function asDate(value: Date | string | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value);
}

class InMemoryVehicleRepository implements IVehicleRepository {
  public vehicles: Vehicle[] = [];

  /**
   * The rows behind the relations the real query joins, seeded by the tests
   * (the twin has no other tables). Names by id; a missing name reads as the
   * NULL a LEFT JOIN gives.
   */
  public driverNames: Record<string, string> = {};
  public branchNames: Record<string, string> = {};
  public vehicleTypeNames: Record<string, string> = {};
  /** The licence each seeded type requires (decision 8.5); absent = none. */
  public vehicleTypeCnh: Record<string, string> = {};

  /**
   * The routes table, for the driver's vehicle access and the status rule.
   * Point it at a route twin: `vehicles.routeSource = () => routes.routes`.
   */
  public routeSource: () => ReadonlyArray<RouteRow> = () => [];

  /** What references each vehicle (fines, fuellings…), seeded by the tests. */
  public usage = new Map<string, Partial<VehicleUsageCounts>>();

  /** @@unique([businessId, license_plate]) and ([businessId, renavam]), case-sensitive. */
  private assertUnique(candidate: Vehicle): void {
    for (const column of ["license_plate", "renavam"] as const) {
      const taken = this.vehicles.some(
        (other) =>
          other.id !== candidate.id &&
          other.businessId === candidate.businessId &&
          other[column] === candidate[column],
      );

      if (taken) throw uniqueViolation(["businessId", column]);
    }
  }

  async createVehicle(vehicleData: CreateVehicleProps): Promise<Vehicle> {
    const newVehicle: Vehicle = {
      id: uuidV7(),
      ...vehicleData,
      // `data: vehicleData` in the Prisma create: an omitted column is NULL,
      // but a 0 km reading or an empty fleet id is stored as given (`|| null`
      // turned a 0 last-maintenance mileage into NULL here).
      fleet_id: vehicleData.fleet_id ?? null,
      last_maintenance_date: vehicleData.last_maintenance_date ?? null,
      last_maintenance_mileage: vehicleData.last_maintenance_mileage ?? null,
      vehicleTypeId: vehicleData.vehicleTypeId ?? null,
      driverId: vehicleData.driverId ?? null,
      branchId: vehicleData.branchId ?? null,
      manufacturing_year: new Date(vehicleData.manufacturing_year),
      model_year: new Date(vehicleData.model_year),
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.assertUnique(newVehicle);

    this.vehicles.push(newVehicle);
    return newVehicle;
  }

  /**
   * Counts and creates together, as the real repository does: a twin that
   * created without the limit would pass the fleet-ceiling test broken.
   */
  async createVehicleWithinLimit(
    vehicleData: CreateVehicleProps,
    limit: { max: number; occupiesSlot: boolean },
  ): Promise<{ vehicle: Vehicle | null; activeCount: number }> {
    const activeCount = this.vehicles.filter(
      (vehicle) =>
        vehicle.businessId === vehicleData.businessId &&
        vehicle.status !== "INACTIVE",
    ).length;

    if (limit.occupiesSlot && limit.max > 0 && activeCount >= limit.max) {
      return { vehicle: null, activeCount };
    }

    return { vehicle: await this.createVehicle(vehicleData), activeCount };
  }

  async updateVehicleWithinLimit(
    {
      vehicleData,
      vehicleId,
      businessId,
    }: UpdateVehicle & { businessId: string },
    limit: { max: number },
  ): Promise<{ vehicle: Vehicle | null; activeCount: number }> {
    const activeCount = this.vehicles.filter(
      (vehicle) =>
        vehicle.businessId === businessId &&
        vehicle.status !== "INACTIVE" &&
        vehicle.id !== vehicleId,
    ).length;

    if (limit.max > 0 && activeCount >= limit.max) {
      return { vehicle: null, activeCount };
    }

    return {
      vehicle: await this.updateVehicle({ vehicleData, vehicleId }),
      activeCount,
    };
  }

  /** The same conditions as vehicleListWhere, over the array. */
  private matches(
    vehicle: Vehicle,
    filters: VehicleListFilters,
    except?: VehicleFacet,
  ): boolean {
    if (vehicle.businessId !== filters.businessId) return false;

    if (
      except !== "status" &&
      filters.statuses?.length &&
      !filters.statuses.includes(vehicle.status)
    ) {
      return false;
    }

    if (
      except !== "branch" &&
      filters.branchIds?.length &&
      !filters.branchIds.includes(vehicle.branchId ?? "")
    ) {
      return false;
    }

    const term = filters.search?.trim().toLowerCase() ?? "";

    if (!term) return true;

    if (matchesIdSearch(vehicle.id, term)) return true;

    return [
      vehicle.description,
      vehicle.license_plate,
      vehicle.brand,
      vehicle.model,
      vehicle.renavam,
      vehicle.fleet_id,
      vehicle.driverId ? this.driverNames[vehicle.driverId] : null,
      vehicle.vehicleTypeId
        ? this.vehicleTypeNames[vehicle.vehicleTypeId]
        : null,
      vehicle.branchId ? this.branchNames[vehicle.branchId] : null,
    ].some((value) => (value ?? "").toLowerCase().includes(term));
  }

  private sortValue(vehicle: Vehicle, key: VehicleSortKey): Comparable {
    switch (key) {
      case "vehicleTypeDescription":
        return vehicle.vehicleTypeId
          ? this.vehicleTypeNames[vehicle.vehicleTypeId]
          : null;
      case "driverName":
        return vehicle.driverId ? this.driverNames[vehicle.driverId] : null;
      case "branchName":
        return vehicle.branchId ? this.branchNames[vehicle.branchId] : null;
      case "created_at":
      case "acquisition_date":
      case "model_year":
      case "last_maintenance_date":
        return asDate(vehicle[key]);
      case "status":
        // Postgres orders an enum by its declaration, not alphabetically.
        return VEHICLE_STATUS_ORDER.indexOf(vehicle.status);
      default:
        return vehicle[key];
    }
  }

  async listVehicles({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListVehicleByBusinessIdProps): Promise<ListVehicleProps> {
    const key = sort ?? VEHICLE_SORT_FALLBACK.sort;
    const direction = order ?? (sort ? "asc" : VEHICLE_SORT_FALLBACK.order);

    // Same order as resolveOrderBy: the column, then created_at desc, id desc.
    const rows = this.vehicles
      .filter((vehicle) => this.matches(vehicle, filters))
      .sort(
        (a, b) =>
          compareNullable(
            this.sortValue(a, key),
            this.sortValue(b, key),
            direction,
          ) ||
          compareNullable(asDate(a.created_at), asDate(b.created_at), "desc") ||
          compareNullable(a.id, b.id, "desc"),
      );

    const skip = (page - 1) * pageSize;

    // Counted over the filter, NOT over the page — the same distinction the
    // real repository makes between the fleet and the page on screen.
    const statusBase = this.vehicles.filter((vehicle) =>
      this.matches(vehicle, filters, "status"),
    );

    const statusCounts = tallyStatuses(
      VEHICLE_STATUSES.map((status) => ({
        status,
        _count: {
          _all: statusBase.filter((vehicle) => vehicle.status === status)
            .length,
        },
      })).filter((group) => group._count._all > 0),
    );

    const branchBase = this.vehicles.filter((vehicle) =>
      this.matches(vehicle, filters, "branch"),
    );

    const branchIds = new Set<string>(filters.branchIds ?? []);

    for (const vehicle of branchBase) {
      if (vehicle.branchId) branchIds.add(vehicle.branchId);
    }

    // Named only from this company's branches (the seeded names), like the
    // real lookup by id AND businessId.
    const branchCounts: VehicleBranchCount[] = [...branchIds]
      .filter((id) => this.branchNames[id] !== undefined)
      .map((id) => ({
        id,
        name: this.branchNames[id],
        count: branchBase.filter((vehicle) => vehicle.branchId === id).length,
      }));

    return {
      data: rows.slice(skip, skip + pageSize),
      statusCounts,
      branchCounts,
    };
  }

  async updateVehicle({
    vehicleData,
    vehicleId,
  }: UpdateVehicle): Promise<Vehicle> {
    const index = this.vehicles.findIndex(
      (vehicle) => vehicle.id === vehicleId,
    );

    if (index === -1) {
      throw recordNotFound("update");
    }

    const filteredData = Object.fromEntries(
      Object.entries(vehicleData).filter(([, value]) => value !== undefined),
    );

    // Handle date conversions if needed
    const processedData = { ...filteredData };
    if (processedData.manufacturing_year) {
      processedData.manufacturing_year = new Date(
        processedData.manufacturing_year as string | Date,
      );
    }
    if (processedData.model_year) {
      processedData.model_year = new Date(
        processedData.model_year as string | Date,
      );
    }

    const updatedVehicle: Vehicle = {
      ...this.vehicles[index],
      ...processedData,
      updated_at: new Date(),
    };

    this.assertUnique(updatedVehicle);

    this.vehicles[index] = updatedVehicle;
    return updatedVehicle;
  }

  async advanceMileageAfterService({
    vehicleId,
    businessId,
    mileage,
    maintenanceDate,
  }: {
    vehicleId: string;
    businessId: string;
    mileage: number;
    maintenanceDate?: Date | string | null;
  }): Promise<boolean> {
    // The same forward-only rule as the real one's WHERE.
    const vehicle = this.vehicles.find(
      (entry) =>
        entry.id === vehicleId &&
        entry.businessId === businessId &&
        entry.current_mileage < mileage,
    );

    if (!vehicle) return false;

    vehicle.current_mileage = mileage;
    vehicle.last_maintenance_mileage = mileage;

    if (maintenanceDate) {
      vehicle.last_maintenance_date = new Date(maintenanceDate);
    }

    return true;
  }

  async deleteVehicle(vehicleId: string): Promise<Vehicle> {
    const index = this.vehicles.findIndex(
      (vehicle) => vehicle.id === vehicleId,
    );

    if (index === -1) {
      throw recordNotFound("delete");
    }

    const deletedVehicle = this.vehicles.splice(index, 1)[0];
    return deletedVehicle;
  }

  async findVehicleById(vehicleId: string): Promise<Vehicle | null> {
    const found = this.vehicles.find((vehicle) => vehicle.id === vehicleId);
    return found || null;
  }

  async findVehicleByLicensePlate(
    licensePlate: string,
    businessId: string,
  ): Promise<Vehicle | null> {
    const found = this.vehicles.find(
      (vehicle) =>
        vehicle.businessId === businessId &&
        vehicle.license_plate.toLowerCase() === licensePlate.toLowerCase(),
    );

    return found || null;
  }

  async findVehicleByRenavam(
    renavam: string,
    businessId: string,
  ): Promise<Vehicle | null> {
    const found = this.vehicles.find(
      (vehicle) =>
        vehicle.businessId === businessId &&
        vehicle.renavam.toLowerCase() === renavam.toLowerCase(),
    );

    return found || null;
  }

  async getVehicleByIdAndBusiness({
    businessId,
    vehicleId,
  }: GetVehicleByIdAndBusinessProps): Promise<Vehicle | null> {
    const found = this.vehicles.find(
      (vehicle) =>
        vehicle.id === vehicleId && vehicle.businessId === businessId,
    );

    return found || null;
  }

  async findVehiclesByFuelTypeId(fuelTypeId: string): Promise<Vehicle[]> {
    return this.vehicles.filter((vehicle) => vehicle.fuelTypeId === fuelTypeId);
  }

  async *streamVehiclesForExport(
    filters: VehicleListFilters,
  ): AsyncGenerator<Record<string, unknown>> {
    const rows = this.vehicles
      .filter((vehicle) => this.matches(vehicle, filters))
      // The real one's keyset: created_at, then id in code-point order.
      .sort(compareExportKeys);

    for (const vehicle of rows) {
      yield {
        id: vehicle.id,
        description: vehicle.description,
        license_plate: vehicle.license_plate,
        brand: vehicle.brand,
        model: vehicle.model,
        acquisition_date: vehicle.acquisition_date,
        fleet_type: vehicle.fleet_type,
        fleet_id: vehicle.fleet_id,
        current_mileage: vehicle.current_mileage,
        last_maintenance_mileage: vehicle.last_maintenance_mileage,
        last_maintenance_date: vehicle.last_maintenance_date,
        maintenance_interval_km: vehicle.maintenance_interval_km,
        maintenance_interval_months: vehicle.maintenance_interval_months,
        renavam: vehicle.renavam,
        manufacturing_year: vehicle.manufacturing_year,
        model_year: vehicle.model_year,
        km_per_liter: vehicle.km_per_liter,
        number_of_axles: vehicle.number_of_axles,
        status: vehicle.status,
        vehicleTypeName: vehicle.vehicleTypeId
          ? (this.vehicleTypeNames[vehicle.vehicleTypeId] ?? null)
          : null,
        fuelTypeName: null,
        driverName: vehicle.driverId
          ? (this.driverNames[vehicle.driverId] ?? null)
          : null,
        driverCpf: null,
        branchName: vehicle.branchId
          ? (this.branchNames[vehicle.branchId] ?? null)
          : null,
        businessId: vehicle.businessId,
        created_at: vehicle.created_at,
        updated_at: vehicle.updated_at,
      };
    }
  }

  async countVehiclesForExport(filters: VehicleListFilters): Promise<number> {
    return this.vehicles.filter((vehicle) => this.matches(vehicle, filters))
      .length;
  }

  private operableBy(vehicle: Vehicle, driverId: string): boolean {
    return canDriverOperateVehicle(
      vehicle,
      driverId,
      this.routeSource().filter(
        (route) => route.businessId === vehicle.businessId,
      ),
    );
  }

  async searchVehicleWithCursor({
    limit = 10,
    cursor,
    businessId,
    driverId,
    search,
    fields = "full",
  }: SearchVehicleWithCursorProps): Promise<CursorPaginatedVehicle> {
    const newestFirst = (a: Vehicle, b: Vehicle) =>
      compareNullable(asDate(a.created_at), asDate(b.created_at), "desc") ||
      compareNullable(a.id, b.id, "desc");

    let filtered = this.vehicles
      .filter(
        (vehicle) =>
          vehicle.businessId === businessId &&
          (!driverId || this.operableBy(vehicle, driverId)) &&
          ["ACTIVE", "IN_ROUTE"].includes(vehicle.status),
      )
      .sort(newestFirst);

    if (search) {
      const term = search.toLowerCase();
      filtered = filtered.filter((vehicle) =>
        [
          vehicle.description,
          vehicle.license_plate,
          vehicle.brand,
          vehicle.model,
          vehicle.renavam,
        ].some((value) => value.toLowerCase().includes(term)),
      );
    }

    filtered = afterCursor(filtered, this.vehicles, cursor, newestFirst);

    const hasMore = filtered.length > limit;

    const page = filtered.slice(0, limit);
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    const driverOf = (vehicle: Vehicle) =>
      vehicle.driverId && this.driverNames[vehicle.driverId]
        ? { name: this.driverNames[vehicle.driverId] }
        : null;

    const typeOf = (vehicle: Vehicle) =>
      vehicle.vehicleTypeId && this.vehicleTypeNames[vehicle.vehicleTypeId]
        ? {
            description: this.vehicleTypeNames[vehicle.vehicleTypeId],
            required_cnh_category:
              this.vehicleTypeCnh[vehicle.vehicleTypeId] ?? null,
          }
        : null;

    const data =
      fields === "choice"
        ? page.map(
            (vehicle): VehicleChoice => ({
              id: vehicle.id,
              description: vehicle.description,
              license_plate: vehicle.license_plate,
              brand: vehicle.brand,
              model: vehicle.model,
              status: vehicle.status,
              businessId: vehicle.businessId,
              driverId: vehicle.driverId ?? null,
              vehicleTypeId: vehicle.vehicleTypeId ?? null,
              driver: driverOf(vehicle),
              vehicleType: typeOf(vehicle),
            }),
          )
        : page.map((vehicle) => ({
            ...vehicle,
            driver: driverOf(vehicle),
            vehicleType: typeOf(vehicle),
          }));

    return { data, nextCursor, hasMore };
  }

  async canDriverOperateVehicle({
    vehicleId,
    driverId,
    businessId,
  }: {
    vehicleId: string;
    driverId: string;
    businessId: string;
  }): Promise<boolean> {
    const vehicle = this.vehicles.find(
      (entry) => entry.id === vehicleId && entry.businessId === businessId,
    );

    return vehicle ? this.operableBy(vehicle, driverId) : false;
  }

  async countOpenRoutesForVehicle(
    vehicleId: string,
    businessId: string,
  ): Promise<OpenRouteCounts> {
    const routes = this.routeSource().filter(
      (route) =>
        route.vehicleId === vehicleId && route.businessId === businessId,
    );

    const countOf = (status: string) =>
      routes.filter((route) => route.status === status).length;

    return {
      planned: countOf("PLANNED"),
      released: countOf("RELEASED"),
      inProgress: countOf("IN_PROGRESS"),
    };
  }

  async countVehicleUsage(vehicleId: string): Promise<VehicleUsageCounts> {
    const seeded = this.usage.get(vehicleId) ?? {};

    return {
      fines: seeded.fines ?? 0,
      fuels: seeded.fuels ?? 0,
      serviceOrders: seeded.serviceOrders ?? 0,
      checklists: seeded.checklists ?? 0,
      accountsPayable: seeded.accountsPayable ?? 0,
    };
  }

  async countVehiclesByStatusForBusiness(
    businessId: string,
  ): Promise<VehicleStatusCounts> {
    const fleet = this.vehicles.filter(
      (vehicle) => vehicle.businessId === businessId,
    );

    // The same shape the database's groupBy gives: no group for an absent
    // status, filled with zero by tallyStatuses.
    return tallyStatuses(
      VEHICLE_STATUSES.map((status) => ({
        status,
        _count: {
          _all: fleet.filter((vehicle) => vehicle.status === status).length,
        },
      })).filter((group) => group._count._all > 0),
    );
  }
}

export { InMemoryVehicleRepository };
