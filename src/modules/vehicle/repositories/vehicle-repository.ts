import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { IVehicleRepository } from "./IVehicle-repository";

import {
  Vehicle,
  CreateVehicleProps,
  ListVehicleProps,
  ListVehicleByBusinessIdProps,
  UpdateVehicle,
  GetVehicleByIdAndBusinessProps,
  SearchVehicleWithCursorProps,
  CursorPaginatedVehicle,
  VehicleUsageCounts,
} from "../dtos/vehicle-dto";
import { tallyStatuses } from "@/shared/vehicle/vehicle-rules";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { resolveOrderBy } from "@/shared/pagination/list-query";
import { insensitiveEquals } from "@/shared/utils/like-pattern";

import { driverOperableVehicleWhere } from "@/shared/vehicle/driver-vehicle-access";
import type { OpenRouteCounts } from "@/shared/vehicle/vehicle-status-change";

import {
  VEHICLE_SORT,
  vehicleListWhere,
  type VehicleBranchCount,
  type VehicleListFilters,
} from "../usecases/list-vehicle/vehicle-list";

/** What a picker needs (DLV-COMBO-1): no odometer, RENAVAM or CNH. */
const VEHICLE_CHOICE_SELECT = {
  id: true,
  description: true,
  license_plate: true,
  brand: true,
  model: true,
  status: true,
  businessId: true,
  driverId: true,
  vehicleTypeId: true,
  driver: { select: { name: true } },
  // The licence the type requires, so the assignment can warn when the
  // driver's does not cover it (decision 8.5).
  vehicleType: { select: { description: true, required_cnh_category: true } },
} satisfies Prisma.VehicleSelect;

class VehicleRepository implements IVehicleRepository {
  constructor(private prisma = database) {}

  async createVehicle(vehicleData: CreateVehicleProps): Promise<Vehicle> {
    const vehicleCreated = await this.prisma.vehicle.create({
      data: vehicleData,
    });

    return vehicleCreated;
  }

  async listVehicles({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListVehicleByBusinessIdProps): Promise<ListVehicleProps> {
    // Two reads at a time at most (tests/E2E/connection-fan-out): the page
    // with the status breakdown, then the branch facet.
    const [vehicleData, statusGroups] = await Promise.all([
      this.prisma.vehicle.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: vehicleListWhere(filters),
        include: {
          vehicleType: { select: { description: true } },
          fuelType: { select: { description: true } },
          driver: { select: { name: true, cnh: true } },
          branch: { select: { corporate_reason: true } },
        },
        orderBy: resolveOrderBy(VEHICLE_SORT, { sort, order }),
      }),
      // The cards and the pager total come from this one grouping, so they
      // cannot disagree; counting the rows on the page would report ten
      // vehicles as if they were the fleet.
      this.prisma.vehicle.groupBy({
        by: ["status"],
        where: vehicleListWhere(filters, { except: "status" }),
        _count: { _all: true },
      }),
    ]);

    const branchCounts = await this.countVehiclesByBranch(filters);

    return {
      data: vehicleData,
      statusCounts: tallyStatuses(statusGroups),
      branchCounts,
    };
  }

  /**
   * The branch facet: vehicles per branch under every filter but the branch
   * one, named from THIS company's branches only — an id of another company
   * in the URL gets neither a count nor a name. A selected branch that
   * matches nothing stays listed with 0 so its chip keeps a name.
   */
  private async countVehiclesByBranch(
    filters: VehicleListFilters,
  ): Promise<VehicleBranchCount[]> {
    const groups = await this.prisma.vehicle.groupBy({
      by: ["branchId"],
      where: vehicleListWhere(filters, { except: "branch" }),
      _count: { _all: true },
    });

    const counts = new Map<string, number>();

    for (const group of groups) {
      if (group.branchId) counts.set(group.branchId, group._count._all);
    }

    const ids = [...new Set([...counts.keys(), ...(filters.branchIds ?? [])])];

    if (ids.length === 0) return [];

    const branches = await this.prisma.branch.findMany({
      where: { id: { in: ids }, businessId: filters.businessId },
      select: { id: true, corporate_reason: true },
    });

    return branches.map((branch) => ({
      id: branch.id,
      name: branch.corporate_reason,
      count: counts.get(branch.id) ?? 0,
    }));
  }

  async updateVehicle(
    { vehicleData, vehicleId }: UpdateVehicle,
    tx?: Prisma.TransactionClient,
  ): Promise<Vehicle> {
    const filteredData = Object.fromEntries(
      Object.entries(vehicleData).filter(([_, value]) => value !== undefined),
    );

    const updateVehicle = await (tx ?? this.prisma).vehicle.update({
      where: {
        id: vehicleId,
      },
      data: filteredData,
    });

    return updateVehicle;
  }

  /**
   * The reactivation twin of createVehicleWithinLimit: the same FOR NO KEY
   * UPDATE on the company row serialises every write that may take a
   * contracted slot, so the count below is not a stale read.
   */
  async updateVehicleWithinLimit(
    {
      vehicleData,
      vehicleId,
      businessId,
    }: UpdateVehicle & { businessId: string },
    limit: { max: number },
  ): Promise<{ vehicle: Vehicle | null; activeCount: number }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "business"
        WHERE "id" = ${businessId}
        FOR NO KEY UPDATE
      `;

      const activeCount = await tx.vehicle.count({
        where: {
          businessId,
          status: { not: "INACTIVE" },
          id: { not: vehicleId },
        },
      });

      if (limit.max > 0 && activeCount >= limit.max) {
        return { vehicle: null, activeCount };
      }

      const vehicle = await this.updateVehicle({ vehicleData, vehicleId }, tx);

      return { vehicle, activeCount };
    });
  }

  async advanceMileageAfterService(
    {
      vehicleId,
      businessId,
      mileage,
      maintenanceDate,
    }: {
      vehicleId: string;
      businessId: string;
      mileage: number;
      maintenanceDate?: Date | string | null;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    // The guard is in the WHERE, so it is judged against the row as it is
    // when the write lands, not as the order read it.
    const moved = await (tx ?? this.prisma).vehicle.updateMany({
      where: { id: vehicleId, businessId, current_mileage: { lt: mileage } },
      data: {
        current_mileage: mileage,
        last_maintenance_mileage: mileage,
        ...(maintenanceDate && {
          last_maintenance_date: new Date(maintenanceDate),
        }),
      },
    });

    return moved.count === 1;
  }

  async deleteVehicle(vehicleId: string): Promise<Vehicle> {
    const deleteVehicle = await this.prisma.vehicle.delete({
      where: {
        id: vehicleId,
      },
    });

    return deleteVehicle;
  }

  async findVehicleById(vehicleId: string): Promise<Vehicle | null> {
    const findVehicleById = await this.prisma.vehicle.findUnique({
      where: {
        id: vehicleId,
      },
      include: {
        vehicleType: true,
        fuelType: true,
        driver: true,
        branch: true,
      },
    });

    return findVehicleById;
  }

  async findVehicleByLicensePlate(
    licensePlate: string,
    businessId: string,
  ): Promise<Vehicle | null> {
    return this.prisma.vehicle.findFirst({
      where: {
        businessId,
        // Escaped: the value is an ILIKE pattern underneath (like-pattern.ts).
        license_plate: insensitiveEquals(licensePlate),
      },
    });
  }

  async findVehicleByRenavam(
    renavam: string,
    businessId: string,
  ): Promise<Vehicle | null> {
    return this.prisma.vehicle.findFirst({
      where: {
        businessId,
        renavam: insensitiveEquals(renavam),
      },
    });
  }

  async getVehicleByIdAndBusiness({
    businessId,
    vehicleId,
  }: GetVehicleByIdAndBusinessProps): Promise<Vehicle | null> {
    const getVehicleByIdAndBusiness = await this.prisma.vehicle.findUnique({
      where: {
        businessId,
        id: vehicleId,
      },
    });

    return getVehicleByIdAndBusiness;
  }

  async findVehiclesByFuelTypeId(fuelTypeId: string): Promise<Vehicle[]> {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { fuelTypeId },
      include: {
        fuelType: { select: { description: true } },
      },
      orderBy: { license_plate: "asc" },
    });

    return vehicles;
  }

  async *streamVehiclesForExport(
    filters: VehicleListFilters,
  ): AsyncGenerator<Record<string, unknown>> {
    const whereCondition = vehicleListWhere(filters);

    const batchSize = 1000;
    let cursor: string | undefined = undefined;

    while (true) {
      const vehicles: Array<
        Vehicle & {
          vehicleType: { description: string } | null;
          fuelType: { description: string } | null;
          driver: { name: string; cpf: string } | null;
          branch: { corporate_reason: string } | null;
        }
      > = await this.prisma.vehicle.findMany({
        where: whereCondition,
        include: {
          vehicleType: { select: { description: true } },
          fuelType: { select: { description: true } },
          driver: { select: { name: true, cpf: true } },
          branch: { select: { corporate_reason: true } },
        },
        orderBy: { id: "asc" },
        take: batchSize,
        ...(cursor && {
          skip: 1,
          cursor: { id: cursor },
        }),
      });

      if (vehicles.length === 0) break;

      for (const v of vehicles) {
        yield {
          id: v.id,
          description: v.description,
          license_plate: v.license_plate,
          brand: v.brand,
          model: v.model,
          acquisition_date: v.acquisition_date,
          fleet_type: v.fleet_type,
          fleet_id: v.fleet_id,
          current_mileage: v.current_mileage,
          last_maintenance_mileage: v.last_maintenance_mileage,
          last_maintenance_date: v.last_maintenance_date,
          maintenance_interval_km: v.maintenance_interval_km,
          maintenance_interval_months: v.maintenance_interval_months,
          renavam: v.renavam,
          manufacturing_year: v.manufacturing_year,
          model_year: v.model_year,
          km_per_liter: v.km_per_liter,
          number_of_axles: v.number_of_axles,
          status: v.status,
          vehicleTypeName: v.vehicleType?.description || null,
          fuelTypeName: v.fuelType?.description || null,
          driverName: v.driver?.name || null,
          driverCpf: v.driver?.cpf || null,
          branchName: v.branch?.corporate_reason || null,
          businessId: v.businessId,
          created_at: v.created_at,
          updated_at: v.updated_at,
        };
      }

      cursor = vehicles[vehicles.length - 1].id;
    }
  }

  async countVehiclesForExport(filters: VehicleListFilters): Promise<number> {
    return this.prisma.vehicle.count({ where: vehicleListWhere(filters) });
  }

  async searchVehicleWithCursor({
    limit = 10,
    cursor,
    businessId,
    driverId,
    search,
    fields = "full",
  }: SearchVehicleWithCursorProps): Promise<CursorPaginatedVehicle> {
    const where: Prisma.VehicleWhereInput = {
      businessId,
      status: {
        in: ["ACTIVE", "IN_ROUTE"],
      },
      AND: [
        ...(driverId ? [driverOperableVehicleWhere(driverId)] : []),
        buildSearchOr<Prisma.VehicleWhereInput>(
          search
            ? [
                { description: { contains: search, mode: "insensitive" } },
                { license_plate: { contains: search, mode: "insensitive" } },
                { brand: { contains: search, mode: "insensitive" } },
                { model: { contains: search, mode: "insensitive" } },
                { renavam: { contains: search, mode: "insensitive" } },
              ]
            : [],
        ),
      ],
    };

    const page = {
      where,
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    } satisfies Prisma.VehicleFindManyArgs;

    const items: CursorPaginatedVehicle["data"] =
      fields === "choice"
        ? await this.prisma.vehicle.findMany({
            ...page,
            select: VEHICLE_CHOICE_SELECT,
          })
        : await this.prisma.vehicle.findMany({
            ...page,
            include: {
              driver: { select: { name: true } },
              vehicleType: {
                select: { description: true, required_cnh_category: true },
              },
            },
          });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

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
    const found = await this.prisma.vehicle.count({
      where: {
        id: vehicleId,
        businessId,
        ...driverOperableVehicleWhere(driverId),
      },
    });

    return found > 0;
  }

  async countOpenRoutesForVehicle(
    vehicleId: string,
    businessId: string,
  ): Promise<OpenRouteCounts> {
    const groups = await this.prisma.route.groupBy({
      by: ["status"],
      where: {
        vehicleId,
        businessId,
        status: { in: ["PLANNED", "RELEASED", "IN_PROGRESS"] },
      },
      _count: { _all: true },
    });

    const countOf = (status: string) =>
      groups.find((group) => group.status === status)?._count._all ?? 0;

    return {
      planned: countOf("PLANNED"),
      released: countOf("RELEASED"),
      inProgress: countOf("IN_PROGRESS"),
    };
  }

  async countVehicleUsage(vehicleId: string): Promise<VehicleUsageCounts> {
    // One statement with five correlated counts, instead of loading every
    // fuelling of the vehicle to read `.length`.
    const found = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: {
        _count: {
          select: {
            Fine: true,
            Fuel: true,
            serviceOrders: true,
            VehicleChecklist: true,
            accountsPayable: true,
          },
        },
      },
    });

    return {
      fines: found?._count.Fine ?? 0,
      fuels: found?._count.Fuel ?? 0,
      serviceOrders: found?._count.serviceOrders ?? 0,
      checklists: found?._count.VehicleChecklist ?? 0,
      accountsPayable: found?._count.accountsPayable ?? 0,
    };
  }

  // A contracted slot is occupied by every non-INACTIVE vehicle —
  // inactivating frees the slot (see occupiesFleetSlot in entitlement-rules).
  async countActiveVehiclesByBusinessId(businessId: string): Promise<number> {
    return this.prisma.vehicle.count({
      where: { businessId, status: { not: "INACTIVE" } },
    });
  }

  /**
   * Creates the vehicle without exceeding the contracted fleet, even under
   * concurrency.
   *
   * Count-then-create is a read-then-write, and the limit is a BILLING
   * control: with nine vehicles on a contract of ten, N simultaneous
   * requests with different plates all read nine, all passed, and the
   * company ended up with 9+N on a contract of ten.
   *
   * Neither an index nor an `updateMany` solves it — "at most N rows per
   * company" is not a condition Postgres can express. Serialising PER
   * COMPANY does: the transaction locks the company's row, and a second
   * registration waits for the first to finish before counting.
   *
   * FOR NO KEY UPDATE, not FOR UPDATE. It conflicts with itself, so the
   * registrations still queue; but it does not conflict with the FOR KEY
   * SHARE that every insert with a foreign key to `business` takes on this
   * row. FOR UPDATE did, and every proof, delivery, route, activity and
   * notification of the company waited for the vehicle to be registered.
   */
  async createVehicleWithinLimit(
    vehicleData: CreateVehicleProps,
    limit: { max: number; occupiesSlot: boolean },
  ): Promise<{ vehicle: Vehicle | null; activeCount: number }> {
    return this.prisma.$transaction(async (tx) => {
      // The lock. Without it the count below is the same stale read as before.
      await tx.$queryRaw`
        SELECT "id" FROM "business"
        WHERE "id" = ${vehicleData.businessId}
        FOR NO KEY UPDATE
      `;

      const activeCount = await tx.vehicle.count({
        where: {
          businessId: vehicleData.businessId,
          status: { not: "INACTIVE" },
        },
      });

      if (limit.occupiesSlot && limit.max > 0 && activeCount >= limit.max) {
        return { vehicle: null, activeCount };
      }

      const vehicle = await tx.vehicle.create({ data: vehicleData });

      return { vehicle, activeCount };
    });
  }

  async countInactiveVehiclesByBusinessId(businessId: string): Promise<number> {
    return this.prisma.vehicle.count({
      where: { businessId, status: "INACTIVE" },
    });
  }
}

export { VehicleRepository };
