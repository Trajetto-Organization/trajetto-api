import { IFuelTypeRepository } from "./IFuel-type-repository";
import {
  FuelType,
  CreateFuelTypeProps,
  ListFuelTypeByBusinessIdProps,
  ListFuelTypeProps,
  UpdateFuelType,
  SearchFuelTypeWithCursorProps,
  CursorPaginatedFuelType,
  FuelTypeUsage,
} from "../dtos/fuel-type-dto";

import database from "@/../infra/database";

import { resolveOrderBy } from "@/shared/pagination/list-query";

import {
  FUEL_TYPE_SORT,
  fuelTypeListWhere,
} from "../usecases/list-fuel-type/fuel-type-list";
import {
  escapeLikePattern,
  insensitiveEquals,
} from "@/shared/utils/like-pattern";

class FuelTypeRepository implements IFuelTypeRepository {
  constructor(private prisma = database) {}

  async createFuelType(fuelTypeData: CreateFuelTypeProps): Promise<FuelType> {
    const fuelTypeCreated = await this.prisma.fuelType.create({
      data: {
        description: fuelTypeData.description,
        business: {
          connect: {
            id: fuelTypeData.businessId,
          },
        },
      },
    });

    return fuelTypeCreated;
  }

  async listFuelTypes({
    page,
    pageSize,
    sort,
    order,
    refuelWindow,
    ...filters
  }: ListFuelTypeByBusinessIdProps): Promise<ListFuelTypeProps> {
    const where = fuelTypeListWhere(filters);

    const [fuelTypeData, usage, refuelings] = await Promise.all([
      this.prisma.fuelType.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where,
        orderBy: resolveOrderBy(FUEL_TYPE_SORT, { sort, order }),
      }),
      // One vehicle count per type of the whole search (at most eight per
      // company), which also answers the pager total.
      this.prisma.fuelType.findMany({
        where,
        select: { id: true, description: true, _count: { select: { vehicles: true } } },
      }),
      refuelWindow
        ? this.prisma.fuel.groupBy({
            by: ["fuelTypeId"],
            where: {
              // Tenant on the refuelling itself as well: the type filter
              // already pins it, this keeps it true if that ever changes.
              businessId: filters.businessId,
              refueling_date: { gte: refuelWindow.start, lt: refuelWindow.end },
              fuelType: where,
            },
            _count: { _all: true },
            _sum: { liters_amount: true, total_amount: true },
          })
        : null,
    ]);

    return {
      data: fuelTypeData,
      total: usage.length,
      usage: usage.map(({ id, description, _count }) => ({
        id,
        label: description,
        count: _count.vehicles,
      })),
      refuelings:
        refuelings?.map((row) => ({
          fuelTypeId: row.fuelTypeId,
          refuelings: row._count._all,
          liters: Number(row._sum.liters_amount ?? 0),
          amount: Number(row._sum.total_amount ?? 0),
        })) ?? null,
    };
  }

  async updateFuelType({
    fuelTypeData,
    fuelTypeId,
  }: UpdateFuelType): Promise<FuelType> {
    // Only the description: a fuel type never changes company (its vehicles
    // and refuelings would point across tenants).
    const filteredData =
      fuelTypeData.description !== undefined &&
      fuelTypeData.description !== null &&
      fuelTypeData.description !== ""
        ? { description: fuelTypeData.description }
        : {};

    const updateFuelType = await this.prisma.fuelType.update({
      where: {
        id: fuelTypeId,
      },
      data: filteredData,
    });

    return updateFuelType;
  }

  async deleteFuelType(fuelTypeId: string): Promise<FuelType> {
    const deleteFuelType = await this.prisma.fuelType.delete({
      where: {
        id: fuelTypeId,
      },
    });

    return deleteFuelType;
  }

  async findFuelTypeById(fuelTypeId: string): Promise<FuelType | null> {
    const findFuelTypeById = await this.prisma.fuelType.findUnique({
      where: {
        id: fuelTypeId,
      },
    });

    return findFuelTypeById;
  }

  async findFuelTypeByIdAndBusiness(
    fuelTypeId: string,
    businessId: string,
  ): Promise<FuelType | null> {
    // findFirst: `findUnique` with an undefined businessId matched the id
    // alone, handing another company's fuel type to the caller.
    const findFuelTypeById = await this.prisma.fuelType.findFirst({
      where: {
        id: fuelTypeId,
        businessId,
      },
    });

    return findFuelTypeById;
  }

  async findFuelTypeByDescription(
    description: string,
    businessId: string,
  ): Promise<FuelType | null> {
    const findFuelTypeByDescription = await this.prisma.fuelType.findFirst({
      where: {
        // Escaped: the value is an ILIKE pattern underneath (like-pattern.ts).
        description: insensitiveEquals(description),
        businessId: businessId,
      },
    });

    return findFuelTypeByDescription;
  }

  async searchFuelTypeWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchFuelTypeWithCursorProps): Promise<CursorPaginatedFuelType> {
    const items = await this.prisma.fuelType.findMany({
      where: {
        businessId,
        ...(search && {
          description: {
            contains: escapeLikePattern(search),
            mode: "insensitive",
          },
        }),
      },
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countFuelTypeUsage(fuelTypeId: string): Promise<FuelTypeUsage> {
    const counted = await this.prisma.fuelType.findUnique({
      where: { id: fuelTypeId },
      select: { _count: { select: { vehicles: true, fuels: true } } },
    });

    return {
      vehicles: counted?._count.vehicles ?? 0,
      fuels: counted?._count.fuels ?? 0,
    };
  }
}

export { FuelTypeRepository };
