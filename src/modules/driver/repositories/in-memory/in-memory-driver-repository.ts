import { afterCursor, byNameThenId } from "@/shared/in-memory/cursor";
import { Prisma } from "@prisma/client";
import { v7 as uuidV7 } from "uuid";

import { IDriverRepository } from "../IDriver-repository";

import {
  DRIVER_COLUMN_DEFAULTS,
  withColumnDefaults,
} from "@/shared/in-memory/column-defaults";
import { asDateColumn } from "@/shared/in-memory/date-column";

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
} from "../../dtos/driver-dto";

import {
  CNH_CATEGORIES,
  CNH_CATEGORY_NONE,
  DRIVER_SORT_FALLBACK,
  type DriverGroupCount,
  type DriverListFilters,
  type DriverSortKey,
} from "../../usecases/list-driver/driver-list";

import {
  NO_OPEN_ROUTES,
  OPEN_ROUTE_STATUSES,
  totalOpenRoutes,
  type OpenRouteCounts,
} from "../../driver-rules";

import { DriverHasOpenRoutesError } from "../../usecases/errors/driver-has-open-routes-error";
import {
  driverHistoryRefusal,
  NO_DRIVER_HISTORY,
} from "../../usecases/errors/driver-history-refusal";

/**
 * What this repository reads of a route row: the driver it waits for and its
 * status. A test that also drives the route use cases hands over the route
 * fake's own `routes` array — in Postgres both read one table.
 */
interface RouteMirror {
  driverId: string;
  status: string;
}

/** What this repository reads of a pause row. */
interface PauseMirror {
  driverId: string;
}

function uniqueViolation(field: "cpf" | "cnh"): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (\`businessId\`,\`${field}\`)`,
    {
      code: "P2002",
      clientVersion: "in-memory",
      meta: { target: ["businessId", field] },
    },
  );
}

/** Postgres ILIKE '%term%' after literalContains: a plain case-insensitive substring. */
const containsInsensitive = (value: string | null | undefined, term: string) =>
  (value ?? "").toLowerCase().includes(term.toLowerCase());

class InMemoryDriverRepository implements IDriverRepository {
  public drivers: Driver[] = [];

  /** Branch names by id, standing in for the branch table (include and facet labels). */
  public branchNames = new Map<string, string>();

  /** Branch owner by id, so the facet labels stay inside the company like the real lookup. */
  public branchBusiness = new Map<string, string>();

  constructor(
    public routes: RouteMirror[] = [],
    public pauses: PauseMirror[] = [],
  ) {}

  /** The table's unique (businessId, cpf) and (businessId, cnh), as P2002. */
  private assertUnique(candidate: Driver): void {
    for (const field of ["cpf", "cnh"] as const) {
      const clash = this.drivers.some(
        (driver) =>
          driver.id !== candidate.id &&
          driver.businessId === candidate.businessId &&
          driver[field] === candidate[field],
      );

      if (clash) throw uniqueViolation(field);
    }
  }

  async createDriver(driverData: CreateDriverProps): Promise<Driver> {
    const newDriver: Driver = {
      id: uuidV7(),
      ...withColumnDefaults(DRIVER_COLUMN_DEFAULTS, driverData),
      cnh_expires_at: asDateColumn(driverData.cnh_expires_at ?? null),
      complement: driverData.complement ?? null,
      branchId: driverData.branchId ?? null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.assertUnique(newDriver);

    this.drivers.push(newDriver);
    return newDriver;
  }

  private matchesSearch(driver: Driver, search: string | undefined): boolean {
    const term = search?.trim() ?? "";

    if (!term) return true;

    const digits = term.replace(/\D/g, "");

    return (
      [
        driver.id,
        driver.name,
        driver.cnh,
        driver.city,
        driver.uf,
        driver.street,
        driver.address_number,
        driver.branchId,
      ].some((value) => containsInsensitive(value, term)) ||
      (digits !== "" &&
        [driver.cpf, driver.cep, driver.rg].some((value) =>
          containsInsensitive(value, digits),
        ))
    );
  }

  private matchesFacets(driver: Driver, filters: DriverListFilters): boolean {
    const category = driver.cnh_category ?? CNH_CATEGORY_NONE;

    return (
      (!filters.statuses?.length || filters.statuses.includes(driver.status)) &&
      (!filters.contractTypes?.length ||
        filters.contractTypes.includes(driver.contract_type)) &&
      (!filters.cnhCategories?.length ||
        filters.cnhCategories.includes(category)) &&
      (!filters.branchIds?.length ||
        (driver.branchId != null && filters.branchIds.includes(driver.branchId)))
    );
  }

  /**
   * The list's order as Postgres gives it: the sort column, NULLs last for
   * the nullable CNH columns in both directions, then created_at desc and id
   * desc.
   */
  private sorted(
    drivers: Driver[],
    sort: DriverSortKey | undefined,
    order: "asc" | "desc" | undefined,
  ): Driver[] {
    const key = sort ?? DRIVER_SORT_FALLBACK.sort;
    const direction =
      (order ?? (sort ? "asc" : DRIVER_SORT_FALLBACK.order)) === "asc" ? 1 : -1;

    const valueOf = (driver: Driver): string | number | null => {
      const value = driver[key];

      if (value === null || value === undefined) return null;
      if (value instanceof Date) return value.getTime();

      // Postgres orders an enum by declaration, not by spelling: AB comes
      // after E. Status and contract type happen to agree with the alphabet.
      if (key === "cnh_category") {
        return (CNH_CATEGORIES as readonly string[]).indexOf(String(value));
      }

      return key === "birth_date" ? new Date(value).getTime() : String(value);
    };

    const compare = (a: string | number, b: string | number) =>
      a < b ? -1 : a > b ? 1 : 0;

    const time = (value: Date | string) => new Date(value).getTime();

    return [...drivers].sort((a, b) => {
      const left = valueOf(a);
      const right = valueOf(b);

      let primary = 0;

      if (left === null || right === null) {
        primary = left === right ? 0 : left === null ? 1 : -1;
      } else {
        primary = direction * compare(left, right);
      }

      return (
        primary ||
        compare(time(b.created_at), time(a.created_at)) ||
        compare(b.id, a.id)
      );
    });
  }

  async listDrivers({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListDriversProps): Promise<ListDriversResult> {
    const base = this.drivers.filter(
      (driver) =>
        driver.businessId === filters.businessId &&
        this.matchesSearch(driver, filters.search),
    );

    const matching = this.sorted(
      base.filter((driver) => this.matchesFacets(driver, filters)),
      sort,
      order,
    );

    const groups = new Map<string, DriverGroupCount>();

    for (const driver of base) {
      const key = [
        driver.status,
        driver.contract_type,
        driver.cnh_category ?? "",
        driver.branchId ?? "",
      ].join("|");

      const group = groups.get(key) ?? {
        status: driver.status,
        contract_type: driver.contract_type,
        cnh_category: driver.cnh_category ?? null,
        branchId: driver.branchId ?? null,
        count: 0,
      };

      group.count += 1;
      groups.set(key, group);
    }

    const skip = (page - 1) * pageSize;

    const data: DriverListRow[] = matching
      .slice(skip, skip + pageSize)
      .map((driver) => ({
        ...driver,
        branch:
          driver.branchId && this.branchNames.has(driver.branchId)
            ? { corporate_reason: this.branchNames.get(driver.branchId)! }
            : null,
      }));

    const wantedBranches = new Set([
      ...[...groups.values()].flatMap((group) =>
        group.branchId ? [group.branchId] : [],
      ),
      ...(filters.branchIds ?? []),
    ]);

    return {
      data,
      groups: [...groups.values()],
      branchNames: new Map(
        [...wantedBranches]
          .filter(
            (id) =>
              this.branchNames.has(id) &&
              this.branchBusiness.get(id) === filters.businessId,
          )
          .map((id) => [id, this.branchNames.get(id)!]),
      ),
    };
  }

  async updateDriver({ driverData, driverId }: UpdateDriver): Promise<Driver> {
    const index = this.drivers.findIndex((driver) => driver.id === driverId);

    if (index === -1) {
      throw new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
        code: "P2025",
        clientVersion: "in-memory",
      });
    }

    const current = this.drivers[index];

    // As Prisma: undefined is "leave it", null clears the column.
    const given = Object.fromEntries(
      Object.entries(driverData).filter(([, value]) => value !== undefined),
    ) as Partial<Driver>;

    if (given.status === "INACTIVE" && current.status === "ACTIVE") {
      const openRoutes = await this.countOpenRoutes(driverId);

      if (totalOpenRoutes(openRoutes) > 0) {
        throw new DriverHasOpenRoutesError(openRoutes);
      }
    }

    const updatedDriver: Driver = {
      ...current,
      ...given,
      ...("cnh_expires_at" in given && {
        cnh_expires_at: asDateColumn(given.cnh_expires_at ?? null),
      }),
      updated_at: new Date(),
    };

    this.assertUnique(updatedDriver);

    this.drivers[index] = updatedDriver;
    return updatedDriver;
  }

  async deleteDriver(driverId: string): Promise<Driver> {
    const index = this.drivers.findIndex((driver) => driver.id === driverId);

    // As Prisma: a missing row is P2025. `splice(-1, 1)` used to delete the
    // LAST driver of the array instead.
    if (index === -1) {
      throw new Prisma.PrismaClientKnownRequestError("Record to delete does not exist.", {
        code: "P2025",
        clientVersion: "in-memory",
      });
    }

    // The real delete counts the history again under the driver row's lock;
    // this twin re-counts what it mirrors (routes and pauses).
    const refusal = driverHistoryRefusal({
      ...NO_DRIVER_HISTORY,
      routes: this.routes.filter((route) => route.driverId === driverId).length,
      pauses: this.pauses.filter((pause) => pause.driverId === driverId).length,
    });

    if (refusal) throw refusal;

    const deletedDriver = this.drivers.splice(index, 1)[0];

    return deletedDriver;
  }

  async findDriverById(driverId: string): Promise<Driver | null> {
    const found = this.drivers.find((driver) => driver.id === driverId);
    return found || null;
  }

  async findDriverByCpf(cpf: string, businessId: string): Promise<Driver | null> {
    return (
      this.drivers.find(
        (driver) => driver.cpf === cpf && driver.businessId === businessId,
      ) ?? null
    );
  }

  async findDriverByCnh(cnh: string, businessId: string): Promise<Driver | null> {
    return (
      this.drivers.find(
        (driver) => driver.cnh === cnh && driver.businessId === businessId,
      ) ?? null
    );
  }

  async findDriverWithUser(
    driverId: string,
  ): Promise<
    | (Driver & { user?: { id: string; email: string; name: string } | null })
    | null
  > {
    const found = this.drivers.find((driver) => driver.id === driverId);

    return found || null;
  }

  async *streamDriversForExport({
    sort,
    order,
    ...filters
  }: DriverExportFilters): AsyncGenerator<any> {
    const matching = this.sorted(
      this.drivers.filter(
        (driver) =>
          driver.businessId === filters.businessId &&
          this.matchesSearch(driver, filters.search) &&
          this.matchesFacets(driver, filters),
      ),
      sort,
      order,
    );

    for (const driver of matching) {
      yield {
        id: driver.id,
        name: driver.name,
        birth_date: driver.birth_date,
        cnh: driver.cnh,
        cnh_category: driver.cnh_category ?? null,
        cnh_expires_at: driver.cnh_expires_at ?? null,
        cpf: driver.cpf,
        rg: driver.rg,
        cep: driver.cep,
        city: driver.city,
        uf: driver.uf,
        street: driver.street,
        address_number: driver.address_number,
        complement: driver.complement,
        status: driver.status,
        contract_type: driver.contract_type,
        branchId: driver.branchId,
        branchName: driver.branchId
          ? (this.branchNames.get(driver.branchId) ?? null)
          : null,
        businessId: driver.businessId,
        created_at: driver.created_at,
        updated_at: driver.updated_at,
      };
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

    let filtered = this.drivers
      .filter(
        (driver) =>
          driver.businessId === businessId && driver.status === "ACTIVE",
      )
      .filter(
        (driver) =>
          !search ||
          containsInsensitive(driver.name, search) ||
          (!choiceOnly && containsInsensitive(driver.cnh, search)),
      )
      // name asc, id asc — the real query's order.
      .sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1,
      );

    // Prisma's cursor: positioned on the cursor ROW, skip 1; an unknown
    // cursor yields nothing (it used to restart the list from the top).
    filtered = afterCursor(filtered, this.drivers, cursor, byNameThenId);

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit).map((driver) => ({
      id: driver.id,
      name: driver.name,
      status: driver.status,
      cnh_category: driver.cnh_category ?? null,
      cnh_expires_at: driver.cnh_expires_at ?? null,
      ...(!choiceOnly && {
        cnh: driver.cnh,
        branchId: driver.branchId ?? null,
        businessId: driver.businessId,
        created_at: driver.created_at,
      }),
    }));
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore } as CursorPaginatedDriver;
  }

  async countDriversForExport(
    filters: Omit<DriverExportFilters, "sort" | "order">,
  ): Promise<number> {
    return this.drivers.filter(
      (driver) =>
        driver.businessId === filters.businessId &&
        this.matchesSearch(driver, filters.search) &&
        this.matchesFacets(driver, filters),
    ).length;
  }

  async countOpenRoutes(driverId: string): Promise<OpenRouteCounts> {
    const counts: OpenRouteCounts = { ...NO_OPEN_ROUTES };

    for (const route of this.routes) {
      if (
        route.driverId === driverId &&
        (OPEN_ROUTE_STATUSES as readonly string[]).includes(route.status)
      ) {
        counts[route.status as keyof OpenRouteCounts] += 1;
      }
    }

    return counts;
  }

  async countDriverPauses(driverId: string): Promise<number> {
    return this.pauses.filter((pause) => pause.driverId === driverId).length;
  }
}

export { InMemoryDriverRepository };
