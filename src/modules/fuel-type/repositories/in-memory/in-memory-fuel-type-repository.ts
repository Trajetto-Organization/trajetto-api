import { compareCodePoints } from "@/shared/pagination/in-memory-order";
import { afterCursor, newestFirst } from "@/shared/in-memory/cursor";
import { recordNotFound } from "@/shared/in-memory/prisma-errors";
import { v7 as uuidV7 } from "uuid";
import { IFuelTypeRepository } from "../IFuel-type-repository";

import {
  FuelType,
  CreateFuelTypeProps,
  ListFuelTypeProps,
  ListFuelTypeByBusinessIdProps,
  UpdateFuelType,
  SearchFuelTypeWithCursorProps,
  CursorPaginatedFuelType,
  FuelTypeUsage,
} from "../../dtos/fuel-type-dto";

import { resolveOrderBy } from "@/shared/pagination/list-query";
import { FUEL_TYPE_SORT } from "../../usecases/list-fuel-type/fuel-type-list";

class InMemoryFuelTypeRepository implements IFuelTypeRepository {
  public fuelTypes: FuelType[] = [];

  async createFuelType(fuelTypeData: CreateFuelTypeProps): Promise<FuelType> {
    const newFuelType: FuelType = {
      id: uuidV7(),
      description: fuelTypeData.description,
      businessId: fuelTypeData.businessId,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.fuelTypes.push(newFuelType);
    return newFuelType;
  }

  async listFuelTypes({
    page,
    pageSize,
    sort,
    order,
    businessId,
    search,
    refuelWindow,
  }: ListFuelTypeByBusinessIdProps): Promise<ListFuelTypeProps> {
    const term = search?.trim().toLowerCase() ?? "";

    const filtered = this.fuelTypes.filter(
      (fuelType) =>
        fuelType.businessId === businessId &&
        (!term ||
          fuelType.id.toLowerCase().includes(term) ||
          fuelType.description.toLowerCase().includes(term)),
    );

    const orderBy = resolveOrderBy(FUEL_TYPE_SORT, { sort, order });

    const value = (fuelType: FuelType, field: string): string | number =>
      field === "description"
        ? fuelType.description
        : field === "id"
          ? fuelType.id
          : new Date(fuelType[field as "created_at" | "updated_at"]).getTime();

    const sorted = [...filtered].sort((a, b) => {
      for (const entry of orderBy) {
        const [field, direction] = Object.entries(entry)[0] as [string, string];
        const left = value(a, field);
        const right = value(b, field);

        const result =
          typeof left === "string" && typeof right === "string"
            ? compareCodePoints(left, right)
            : Number(left) - Number(right);

        if (result !== 0) return direction === "desc" ? -result : result;
      }

      return 0;
    });

    const skip = (page - 1) * pageSize;

    return {
      data: sorted.slice(skip, skip + pageSize),
      total: filtered.length,
      usage: filtered.map((fuelType) => ({
        id: fuelType.id,
        label: fuelType.description,
        count: this.vehicleFuelTypeIds.filter((id) => id === fuelType.id)
          .length,
      })),
      refuelings: refuelWindow
        ? this.refuelingsIn(
            businessId,
            new Set(filtered.map((row) => row.id)),
            refuelWindow,
          )
        : null,
    };
  }

  async updateFuelType({
    fuelTypeData,
    fuelTypeId,
  }: UpdateFuelType): Promise<FuelType> {
    const index = this.fuelTypes.findIndex(
      (fuelType) => fuelType.id === fuelTypeId,
    );

    if (index === -1) {
      throw recordNotFound("update");
    }

    // Only the description, like the repository.
    const filteredData =
      fuelTypeData.description !== undefined &&
      fuelTypeData.description !== null &&
      fuelTypeData.description !== ""
        ? { description: fuelTypeData.description }
        : {};

    const updatedFuelType: FuelType = {
      ...this.fuelTypes[index],
      ...filteredData,
      updated_at: new Date(),
    };

    this.fuelTypes[index] = updatedFuelType;
    return updatedFuelType;
  }

  async deleteFuelType(fuelTypeId: string): Promise<FuelType> {
    const index = this.fuelTypes.findIndex(
      (fuelType) => fuelType.id === fuelTypeId,
    );

    if (index === -1) {
      throw recordNotFound("delete");
    }

    const deletedFuelType = this.fuelTypes.splice(index, 1)[0];
    return deletedFuelType;
  }

  async findFuelTypeById(fuelTypeId: string): Promise<FuelType | null> {
    const fuelType = this.fuelTypes.find(
      (fuelType) => fuelType.id === fuelTypeId,
    );

    return fuelType || null;
  }

  async findFuelTypeByIdAndBusiness(
    fuelTypeId: string,
    businessId: string,
  ): Promise<FuelType | null> {
    const fuelType = this.fuelTypes.find(
      (fuelType) =>
        fuelType.id === fuelTypeId && fuelType.businessId === businessId,
    );

    return fuelType || null;
  }

  async findFuelTypeByDescription(
    description: string,
    businessId: string,
  ): Promise<FuelType | null> {
    // Case-insensitive, like the repository's insensitiveEquals.
    const fuelType = this.fuelTypes.find(
      (fuelType) =>
        fuelType.description.toLowerCase() === description.toLowerCase() &&
        fuelType.businessId === businessId,
    );

    return fuelType || null;
  }

  async searchFuelTypeWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchFuelTypeWithCursorProps): Promise<CursorPaginatedFuelType> {
    // Newest first, like the repository's (created_at, id) order.
    let filtered = this.fuelTypes
      .filter((ft) => ft.businessId === businessId)
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime() ||
          b.id.localeCompare(a.id),
      );

    if (search) {
      const term = search.toLowerCase();
      filtered = filtered.filter((fuelType) =>
        fuelType.description.toLowerCase().includes(term),
      );
    }

    // Prisma's cursor: positioned on the cursor ROW, skip 1; an unknown
    // cursor yields nothing (it used to restart the list from the top).
    filtered = afterCursor(filtered, this.fuelTypes, cursor, newestFirst);

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  /**
   * What points at a fuel type. The twin has no vehicle table: tests seed
   * `vehicleFuelTypeIds` (one entry per vehicle) and may hand it the fuel
   * twin, whose rows are counted as the repository counts `fuel`.
   */
  public vehicleFuelTypeIds: string[] = [];

  /**
   * Refuelings as the fuel table holds them. Rows seeded with only
   * `fuelTypeId` count for the deletion guard; the cards also need the
   * company, the date and the amounts.
   */
  public fuelRows: Array<{
    fuelTypeId: string;
    businessId?: string;
    refueling_date?: Date;
    liters_amount?: number;
    total_amount?: number;
  }> = [];

  /** The repository's groupBy over `fuel`, per type, inside [start, end). */
  private refuelingsIn(
    businessId: string,
    typeIds: ReadonlySet<string>,
    window: { start: Date; end: Date },
  ) {
    const byType = new Map<
      string,
      { refuelings: number; liters: number; amount: number }
    >();

    for (const row of this.fuelRows) {
      const date = row.refueling_date?.getTime();

      if (
        row.businessId !== businessId ||
        !typeIds.has(row.fuelTypeId) ||
        date === undefined ||
        date < window.start.getTime() ||
        date >= window.end.getTime()
      ) {
        continue;
      }

      const entry = byType.get(row.fuelTypeId) ?? {
        refuelings: 0,
        liters: 0,
        amount: 0,
      };

      entry.refuelings += 1;
      entry.liters += row.liters_amount ?? 0;
      entry.amount += row.total_amount ?? 0;
      byType.set(row.fuelTypeId, entry);
    }

    return [...byType].map(([fuelTypeId, entry]) => ({ fuelTypeId, ...entry }));
  }

  async countFuelTypeUsage(fuelTypeId: string): Promise<FuelTypeUsage> {
    return {
      vehicles: this.vehicleFuelTypeIds.filter((id) => id === fuelTypeId)
        .length,
      fuels: this.fuelRows.filter((row) => row.fuelTypeId === fuelTypeId)
        .length,
    };
  }
}

export { InMemoryFuelTypeRepository };
