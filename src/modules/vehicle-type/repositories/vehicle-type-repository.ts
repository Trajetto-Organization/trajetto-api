import database from "@/../infra/database";
import { IVehicleTypeRepository } from "./IVehicle-type-repository";

import {
  VehicleType,
  CreateVehicleTypeProps,
  ListVehicleTypeByBusinessIdProps,
  ListVehicleTypeProps,
  UpdateVehicleType,
  SearchVehicleTypeWithCursorProps,
  CursorPaginatedVehicleType,
} from "../dtos/vehicle-type-dto";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { resolveOrderBy } from "@/shared/pagination/list-query";
import { insensitiveEquals } from "@/shared/utils/like-pattern";

import {
  VEHICLE_TYPE_SORT,
  vehicleTypeListWhere,
} from "../usecases/list-vehicle-type/vehicle-type-list";

class VehicleTypeRepository implements IVehicleTypeRepository {
  constructor(private prisma = database) {}

  async createVehicleType(
    vehicleTypeData: CreateVehicleTypeProps,
  ): Promise<VehicleType> {
    const vehicleTypeCreated = await this.prisma.vehicleType.create({
      data: vehicleTypeData,
    });

    return vehicleTypeCreated;
  }

  async listVehicleTypes({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListVehicleTypeByBusinessIdProps): Promise<ListVehicleTypeProps> {
    const where = vehicleTypeListWhere(filters);

    const [vehicleTypeData, usage] = await Promise.all([
      this.prisma.vehicleType.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where,
        include: { _count: { select: { vehicles: true } } },
        orderBy: resolveOrderBy(VEHICLE_TYPE_SORT, { sort, order }),
      }),
      // One vehicle count per type of the whole search, for the cards: a
      // company has a few dozen types at most, so this also answers the
      // pager total without a separate COUNT.
      this.prisma.vehicleType.findMany({
        where,
        select: { id: true, description: true, _count: { select: { vehicles: true } } },
      }),
    ]);

    return {
      data: vehicleTypeData,
      total: usage.length,
      usage: usage.map(({ id, description, _count }) => ({
        id,
        label: description,
        count: _count.vehicles,
      })),
    };
  }

  async updateVehicleType({
    vehicleTypeData,
    vehicleTypeId,
  }: UpdateVehicleType): Promise<VehicleType> {
    // Only `undefined` means "not sent": the required licence can be cleared
    // with null, and dropping nulls here made that impossible.
    const filteredData = Object.fromEntries(
      Object.entries(vehicleTypeData).filter(([_, value]) => value !== undefined),
    );

    return this.prisma.vehicleType.update({
      where: { id: vehicleTypeId },
      data: filteredData,
    });
  }

  async deleteVehicleType(vehicleTypeId: string): Promise<VehicleType> {
    const deleteVehicleType = await this.prisma.vehicleType.delete({
      where: {
        id: vehicleTypeId,
      },
    });

    return deleteVehicleType;
  }

  async findVehicleTypeById(
    vehicleTypeId: string,
  ): Promise<VehicleType | null> {
    const findVehicleTypeById = await this.prisma.vehicleType.findUnique({
      where: {
        id: vehicleTypeId,
      },
    });

    return findVehicleTypeById;
  }

  async findVehicleTypeByIdAndBusiness(
    vehicleTypeId: string,
    businessId: string,
  ): Promise<VehicleType | null> {
    return this.prisma.vehicleType.findFirst({
      where: { id: vehicleTypeId, businessId },
    });
  }

  async findVehicleTypeByDescription(
    description: string,
    businessId: string,
  ): Promise<VehicleType | null> {
    const findVehicleTypeByDescription =
      await this.prisma.vehicleType.findFirst({
        where: {
          // Escaped: the value is an ILIKE pattern underneath (like-pattern.ts).
          description: insensitiveEquals(description),
          businessId: businessId,
        },
      });

    return findVehicleTypeByDescription;
  }

  async searchVehicleTypeWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchVehicleTypeWithCursorProps): Promise<CursorPaginatedVehicleType> {
    const items = await this.prisma.vehicleType.findMany({
      where: {
        businessId,
        // The typed term, on the server: a type not in the loaded pages can
        // still be found (FLEET-SEARCH-1).
        ...buildSearchOr(
          search ? [{ description: { contains: search, mode: "insensitive" as const } }] : [],
        ),
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countVehiclesUsingType(vehicleTypeId: string): Promise<number> {
    return this.prisma.vehicle.count({ where: { vehicleTypeId } });
  }
}

export { VehicleTypeRepository };
