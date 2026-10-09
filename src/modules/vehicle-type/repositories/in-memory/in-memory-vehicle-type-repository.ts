import { afterCursor, newestFirst } from "@/shared/in-memory/cursor";
import { recordNotFound } from "@/shared/in-memory/prisma-errors";
import { v7 as uuidV7 } from "uuid";
import { IVehicleTypeRepository } from "../IVehicle-type-repository";

import { VEHICLE_TYPE_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import {
  VehicleType,
  VehicleTypeListRow,
  CreateVehicleTypeProps,
  ListVehicleTypeProps,
  ListVehicleTypeByBusinessIdProps,
  UpdateVehicleType,
  SearchVehicleTypeWithCursorProps,
  CursorPaginatedVehicleType,
} from "../../dtos/vehicle-type-dto";

import {
  VEHICLE_TYPE_SORT_FALLBACK,
  type VehicleTypeSortKey,
} from "../../usecases/list-vehicle-type/vehicle-type-list";
import type { SortOrder } from "@/shared/pagination/list-query";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Comparable = string | number | null | undefined;

/** Postgres order: NULLS LAST ascending, NULLS FIRST descending. */
function compareNullable(a: Comparable, b: Comparable, order: SortOrder): number {
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

class InMemoryVehicleTypeRepository implements IVehicleTypeRepository {
  public vehicleTypes: VehicleType[] = [];

  /**
   * The vehicles table, for the counts the real queries join. Point it at a
   * vehicle twin: `types.vehicleSource = () => vehicles.vehicles`.
   */
  public vehicleSource: () => ReadonlyArray<{ vehicleTypeId?: string | null }> =
    () => [];

  async createVehicleType(
    vehicleTypeData: CreateVehicleTypeProps,
  ): Promise<VehicleType> {
    const newVehicleType: VehicleType = {
      ...VEHICLE_TYPE_COLUMN_DEFAULTS,
      id: uuidV7(),
      description: vehicleTypeData.description,
      number_of_axles: vehicleTypeData.number_of_axles,
      // Listed key by key (schema-spec, "Regra dos gêmeos"): an omitted
      // value is the column's NULL, as in Postgres.
      required_cnh_category: vehicleTypeData.required_cnh_category ?? null,
      businessId: vehicleTypeData.businessId,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.vehicleTypes.push(newVehicleType);
    return newVehicleType;
  }

  private vehicleCount(vehicleTypeId: string): number {
    return this.vehicleSource().filter(
      (vehicle) => vehicle.vehicleTypeId === vehicleTypeId,
    ).length;
  }

  private sortValue(row: VehicleTypeListRow, key: VehicleTypeSortKey): Comparable {
    switch (key) {
      case "created_at":
        return new Date(row.created_at).getTime();
      case "vehicleCount":
        return row._count.vehicles;
      default:
        return row[key];
    }
  }

  async listVehicleTypes({
    page,
    pageSize,
    businessId,
    search,
    sort,
    order,
  }: ListVehicleTypeByBusinessIdProps): Promise<ListVehicleTypeProps> {
    const term = search?.trim().toLowerCase() ?? "";

    const matching = this.vehicleTypes.filter((vehicleType) => {
      if (vehicleType.businessId !== businessId) return false;
      if (!term) return true;

      return (
        (UUID_PATTERN.test(term) && vehicleType.id.toLowerCase() === term) ||
        vehicleType.description.toLowerCase().includes(term) ||
        (/^\d+$/.test(term) &&
          Number(term) <= 1000 &&
          vehicleType.number_of_axles === Number(term))
      );
    });

    const key = sort ?? VEHICLE_TYPE_SORT_FALLBACK.sort;
    const direction = order ?? (sort ? "asc" : VEHICLE_TYPE_SORT_FALLBACK.order);

    const rows: VehicleTypeListRow[] = matching
      .map((vehicleType) => ({
        ...vehicleType,
        _count: { vehicles: this.vehicleCount(vehicleType.id) },
      }))
      .sort(
        (a, b) =>
          compareNullable(this.sortValue(a, key), this.sortValue(b, key), direction) ||
          compareNullable(
            new Date(a.created_at).getTime(),
            new Date(b.created_at).getTime(),
            "desc",
          ) ||
          compareNullable(a.id, b.id, "desc"),
      );

    const skip = (page - 1) * pageSize;

    return {
      data: rows.slice(skip, skip + pageSize),
      total: rows.length,
      usage: rows.map((row) => ({
        id: row.id,
        label: row.description,
        count: row._count.vehicles,
      })),
    };
  }

  async updateVehicleType({
    vehicleTypeData,
    vehicleTypeId,
  }: UpdateVehicleType): Promise<VehicleType> {
    const index = this.vehicleTypes.findIndex(
      (vehicleType) => vehicleType.id === vehicleTypeId,
    );

    if (index === -1) {
      throw recordNotFound("update");
    }

    // Like the real one: only `undefined` is "not sent".
    const filteredData = Object.fromEntries(
      Object.entries(vehicleTypeData).filter(([, value]) => value !== undefined),
    );

    const updatedVehicleType: VehicleType = {
      ...this.vehicleTypes[index],
      ...filteredData,
      updated_at: new Date(),
    };

    this.vehicleTypes[index] = updatedVehicleType;
    return updatedVehicleType;
  }

  async deleteVehicleType(vehicleTypeId: string): Promise<VehicleType> {
    const index = this.vehicleTypes.findIndex(
      (vehicleType) => vehicleType.id === vehicleTypeId,
    );

    if (index === -1) {
      throw recordNotFound("delete");
    }

    const deletedVehicleType = this.vehicleTypes.splice(index, 1)[0];
    return deletedVehicleType;
  }

  async findVehicleTypeById(
    vehicleTypeId: string,
  ): Promise<VehicleType | null> {
    const vehicleType = this.vehicleTypes.find(
      (vehicleType) => vehicleType.id === vehicleTypeId,
    );

    return vehicleType || null;
  }

  async findVehicleTypeByIdAndBusiness(
    vehicleTypeId: string,
    businessId: string,
  ): Promise<VehicleType | null> {
    const vehicleType = this.vehicleTypes.find(
      (vehicleType) =>
        vehicleType.id === vehicleTypeId &&
        vehicleType.businessId === businessId,
    );

    return vehicleType || null;
  }

  async findVehicleTypeByDescription(
    description: string,
    businessId: string,
  ): Promise<VehicleType | null> {
    // Case-insensitive equality, like the real ILIKE lookup.
    const vehicleType = this.vehicleTypes.find(
      (vehicleType) =>
        vehicleType.description.toLowerCase() === description.toLowerCase() &&
        vehicleType.businessId === businessId,
    );

    return vehicleType || null;
  }

  async searchVehicleTypeWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchVehicleTypeWithCursorProps): Promise<CursorPaginatedVehicleType> {
    const term = search?.toLowerCase() ?? "";

    let filtered = this.vehicleTypes
      .filter(
        (vt) =>
          vt.businessId === businessId &&
          (!term || vt.description.toLowerCase().includes(term)),
      )
      .sort(
        (a, b) =>
          compareNullable(
            new Date(a.created_at).getTime(),
            new Date(b.created_at).getTime(),
            "desc",
          ) || compareNullable(a.id, b.id, "desc"),
      );

    // Prisma's cursor: positioned on the cursor ROW, skip 1; an unknown
    // cursor yields nothing (it used to restart the list from the top).
    filtered = afterCursor(filtered, this.vehicleTypes, cursor, newestFirst);

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countVehiclesUsingType(vehicleTypeId: string): Promise<number> {
    return this.vehicleCount(vehicleTypeId);
  }
}

export { InMemoryVehicleTypeRepository };
