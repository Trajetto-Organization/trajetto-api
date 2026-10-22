import { Prisma } from "@prisma/client";

import { IDriverRepository } from "./IDriver-repository";
import {
  Driver,
  CreateDriverProps,
  DriverExportFilters,
  DriverListRow,
  ListDriversProps,
  ListDriversResult,
  UpdateDriver,
  SearchDriverWithCursorProps,
  CursorPaginatedDriver,
} from "../dtos/driver-dto";

import database from "@/../infra/database";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { resolveOrderBy } from "@/shared/pagination/list-query";

import {
  DRIVER_SORT,
  driverListWhere,
  type DriverGroupCount,
} from "../usecases/list-driver/driver-list";

import {
  NO_OPEN_ROUTES,
  OPEN_ROUTE_STATUSES,
  totalOpenRoutes,
  type OpenRouteCounts,
} from "../driver-rules";

import { DriverHasOpenRoutesError } from "../usecases/errors/driver-has-open-routes-error";
import {
  driverHistoryRefusal,
  NO_DRIVER_HISTORY,
  type DriverHistoryCounts,
} from "../usecases/errors/driver-history-refusal";

type Client = Prisma.TransactionClient | typeof database;

/** Prisma skips an `undefined` key; the twin does the same with this. */
function definedOnly<T extends object>(data: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

async function openRoutesOf(
  client: Client,
  driverId: string,
): Promise<OpenRouteCounts> {
  const grouped = await client.route.groupBy({
    by: ["status"],
    where: { driverId, status: { in: [...OPEN_ROUTE_STATUSES] } },
    _count: { _all: true },
  });

  const counts: OpenRouteCounts = { ...NO_OPEN_ROUTES };

  for (const entry of grouped) {
    counts[entry.status as keyof OpenRouteCounts] = entry._count._all;
  }

  return counts;
}

/**
 * Every row that still points at the driver, in one round trip. Each table
 * has an index leading with driverId.
 */
async function driverHistoryOf(
  client: Client,
  driverId: string,
): Promise<DriverHistoryCounts> {
  const [row] = await client.$queryRaw<DriverHistoryCounts[]>`
    SELECT
      (SELECT count(*) FROM "user"              WHERE "driverId" = ${driverId})::int AS "users",
      (SELECT count(*) FROM "fine"              WHERE "driverId" = ${driverId})::int AS "fines",
      (SELECT count(*) FROM "fuel"              WHERE "driverId" = ${driverId})::int AS "fuels",
      (SELECT count(*) FROM "vehicle_checklist" WHERE "driverId" = ${driverId})::int AS "checklists",
      (SELECT count(*) FROM "delivery"          WHERE "driverId" = ${driverId})::int AS "deliveries",
      (SELECT count(*) FROM "route"             WHERE "driverId" = ${driverId})::int AS "routes",
      (SELECT count(*) FROM "driver_pause"      WHERE "driverId" = ${driverId})::int AS "pauses"
  `;

  return row ?? { ...NO_DRIVER_HISTORY };
}

class DriverRepository implements IDriverRepository {
  constructor(private prisma = database) {}

  async createDriver(driverData: CreateDriverProps): Promise<Driver> {
    const driverCreated = await this.prisma.driver.create({
      data: driverData,
    });

    return driverCreated;
  }

  async listDrivers({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListDriversProps): Promise<ListDriversResult> {
    // Two connections at most (tests/E2E/driver-list-fan-out): the page and
    // the grouped counts side by side, then the branch names.
    const [data, grouped] = await Promise.all([
      this.prisma.driver.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: driverListWhere(filters, { withFacets: true }),
        orderBy: resolveOrderBy(DRIVER_SORT, { sort, order }),
        include: { branch: { select: { corporate_reason: true } } },
      }),
      this.prisma.driver.groupBy({
        by: ["status", "contract_type", "cnh_category", "branchId"],
        where: driverListWhere(filters, { withFacets: false }),
        _count: { _all: true },
      }),
    ]);

    const groups: DriverGroupCount[] = grouped.map((entry) => ({
      status: entry.status,
      contract_type: entry.contract_type,
      cnh_category: entry.cnh_category,
      branchId: entry.branchId,
      count: entry._count._all,
    }));

    const branchIds = [
      ...new Set([
        ...groups.flatMap((group) => (group.branchId ? [group.branchId] : [])),
        ...(filters.branchIds ?? []),
      ]),
    ];

    // Scoped by company: a branch id of another tenant pasted in the URL
    // brings back neither rows nor its name.
    const branches =
      branchIds.length > 0
        ? await this.prisma.branch.findMany({
            where: { businessId: filters.businessId, id: { in: branchIds } },
            select: { id: true, corporate_reason: true },
          })
        : [];

    return {
      data: data as DriverListRow[],
      groups,
      branchNames: new Map(
        branches.map((branch) => [branch.id, branch.corporate_reason]),
      ),
    };
  }

  async updateDriver({ driverData, driverId }: UpdateDriver): Promise<Driver> {
    const data = definedOnly(driverData);

    if (data.status !== "INACTIVE") {
      return this.prisma.driver.update({ where: { id: driverId }, data });
    }

    /**
     * FOR UPDATE: the count and the write see the same world. A route created
     * concurrently takes the driver row's KEY SHARE lock through its foreign
     * key, which waits for this transaction; the route writers re-read the
     * status under a lock of their own (cross-note to the route package).
     */
    return this.prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status"::text AS "status"
          FROM "driver"
         WHERE "id" = ${driverId}
         FOR UPDATE
      `;

      // Only the move from ACTIVE: editing a driver who is already inactive
      // must not be blocked by whatever the past left behind.
      if (current?.status === "ACTIVE") {
        const openRoutes = await openRoutesOf(tx, driverId);

        if (totalOpenRoutes(openRoutes) > 0) {
          throw new DriverHasOpenRoutesError(openRoutes);
        }
      }

      return tx.driver.update({ where: { id: driverId }, data });
    });
  }

  async deleteDriver(driverId: string): Promise<Driver> {
    /**
     * FOR UPDATE, then the history again, then the delete. The use case's
     * guards read before this transaction: a pause, route or app account
     * written in between used to meet the RESTRICT key (a 500) or be set to
     * NULL without a word. Any row that points at the driver takes the
     * driver row's KEY SHARE lock through its foreign key, so it either
     * committed before this lock (and is counted here) or waits for the
     * delete and then fails on its own key.
     */
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "driver" WHERE "id" = ${driverId} FOR UPDATE
      `;

      // A missing row is left to the delete below: Prisma's P2025, as before.
      if (locked) {
        const refusal = driverHistoryRefusal(
          await driverHistoryOf(tx, driverId),
        );

        if (refusal) throw refusal;
      }

      return tx.driver.delete({ where: { id: driverId } });
    });
  }

  async findDriverById(driverId: string): Promise<Driver | null> {
    const findDriverById = await this.prisma.driver.findUnique({
      where: {
        id: driverId,
      },
      include: {
        branch: {
          select: {
            is_active: true,
          },
        },
        User: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    return findDriverById;
  }

  async findDriverByCpf(
    cpf: string,
    businessId: string,
  ): Promise<Driver | null> {
    return this.prisma.driver.findUnique({
      where: { businessId_cpf: { businessId, cpf } },
    });
  }

  async findDriverByCnh(
    cnh: string,
    businessId: string,
  ): Promise<Driver | null> {
    return this.prisma.driver.findUnique({
      where: { businessId_cnh: { businessId, cnh } },
    });
  }

  async findDriverWithUser(driverId: string): Promise<
    | (Driver & {
        user?: { id: string; email: string; name: string } | null;
      })
    | null
  > {
    const driver = await this.prisma.driver.findUnique({
      where: {
        id: driverId,
      },
      include: {
        branch: true,
        User: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    return driver;
  }

  async *streamDriversForExport({
    sort,
    order,
    ...filters
  }: DriverExportFilters): AsyncGenerator<any> {
    const where = driverListWhere(filters, { withFacets: true });
    const orderBy = resolveOrderBy(DRIVER_SORT, { sort, order });

    const batchSize = 1000;
    let cursor: string | undefined = undefined;

    while (true) {
      // The list's own order: the id tiebreaker keeps the cursor stable.
      const drivers: Array<
        Driver & { branch: { corporate_reason: string } | null }
      > = await this.prisma.driver.findMany({
        where,
        include: { branch: { select: { corporate_reason: true } } },
        orderBy,
        take: batchSize,
        ...(cursor && {
          skip: 1,
          cursor: { id: cursor },
        }),
      });

      if (drivers.length === 0) break;

      for (const d of drivers) {
        yield {
          id: d.id,
          name: d.name,
          birth_date: d.birth_date,
          cnh: d.cnh,
          cnh_category: d.cnh_category ?? null,
          cnh_expires_at: d.cnh_expires_at ?? null,
          cpf: d.cpf,
          rg: d.rg,
          cep: d.cep,
          city: d.city,
          uf: d.uf,
          street: d.street,
          address_number: d.address_number,
          complement: d.complement,
          status: d.status,
          contract_type: d.contract_type,
          branchId: d.branchId,
          branchName: d.branch?.corporate_reason || null,
          businessId: d.businessId,
          created_at: d.created_at,
          updated_at: d.updated_at,
        };
      }

      if (drivers.length < batchSize) break;

      cursor = drivers[drivers.length - 1].id;
    }
  }

  async searchDriverWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
    projection = "catalog",
  }: SearchDriverWithCursorProps): Promise<CursorPaginatedDriver> {
    const choiceOnly = projection === "choice";

    const items = await this.prisma.driver.findMany({
      where: {
        businessId,
        status: "ACTIVE",
        // A dispatcher does not see the CNH number, so it is not searchable
        // for them either: a hit would reveal it.
        ...(search &&
          buildSearchOr<Prisma.DriverWhereInput>([
            { name: { contains: search, mode: "insensitive" } },
            ...(choiceOnly
              ? []
              : [{ cnh: { contains: search, mode: "insensitive" as const } }]),
          ])),
      },
      select: {
        id: true,
        name: true,
        status: true,
        cnh_category: true,
        cnh_expires_at: true,
        ...(!choiceOnly && {
          cnh: true,
          branchId: true,
          businessId: true,
          created_at: true,
        }),
      },
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      // Alphabetical, as a picker is read; the id keeps equal names in one
      // order across pages.
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore } as CursorPaginatedDriver;
  }

  async countDriversForExport(
    filters: Omit<DriverExportFilters, "sort" | "order">,
  ): Promise<number> {
    // The stream's own where: a count of something else answered a filter
    // that kept nothing with a header-only file.
    return this.prisma.driver.count({
      where: driverListWhere(filters, { withFacets: true }),
    });
  }

  async countOpenRoutes(driverId: string): Promise<OpenRouteCounts> {
    return openRoutesOf(this.prisma, driverId);
  }

  async countDriverPauses(driverId: string): Promise<number> {
    return this.prisma.driverPause.count({ where: { driverId } });
  }
}

export { DriverRepository };
