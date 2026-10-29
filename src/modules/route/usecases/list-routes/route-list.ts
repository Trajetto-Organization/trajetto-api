import type { Prisma } from "@prisma/client";

import { idSearchConditions } from "@/shared/pagination/id-search";
import { buildSearchOr } from "@/shared/pagination/search-or";
import {
  routeCodeFromSearch,
  type RouteStatus,
} from "@/shared/route/route-rules";

import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

/**
 * The routes board on the server (decision 8.8): what it sorts by, what it
 * filters by, the cards and the filter counts. The web table used to filter
 * status, driver and vehicle among the ten rows it had loaded.
 */

/** In the enum's declared order, which is also how Postgres sorts it. */
const ROUTE_LIST_STATUSES = [
  "PLANNED",
  "RELEASED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const satisfies readonly RouteStatus[];

/** Same ids as the web table's columns: the URL value is the column id. */
const ROUTE_SORT_KEYS = [
  "created_at",
  "updated_at",
  "code",
  "status",
  "driverName",
  "vehiclePlate",
  "scheduled_date",
  "destination",
  "started_at",
  "completed_at",
] as const;

type RouteSortKey = (typeof ROUTE_SORT_KEYS)[number];

const ROUTE_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

const ROUTE_SORT: SortSpec<RouteSortKey, Prisma.RouteOrderByWithRelationInput> =
  {
    keys: ROUTE_SORT_KEYS,
    fallback: ROUTE_SORT_FALLBACK,
    columns: {
      created_at: (order: SortOrder) => ({ created_at: order }),
      updated_at: (order: SortOrder) => ({ updated_at: order }),
      code: (order: SortOrder) => ({ code: order }),
      // The lifecycle order (planned → cancelled), the enum's declared one.
      status: (order: SortOrder) => ({ status: order }),
      driverName: (order: SortOrder) => ({ driver: { name: order } }),
      // Optional relation: Prisma takes no `nulls` here, so "Sem veículo" is
      // last on asc and first on desc (Postgres' default for NULL).
      vehiclePlate: (order: SortOrder) => ({
        vehicle: { license_plate: order },
      }),
      scheduled_date: (order: SortOrder) => ({ scheduled_date: order }),
      // A route with no destination or not yet departed/closed never opens the list.
      destination: (order: SortOrder) => ({
        destination: { sort: order, nulls: "last" },
      }),
      started_at: (order: SortOrder) => ({
        started_at: { sort: order, nulls: "last" },
      }),
      completed_at: (order: SortOrder) => ({
        completed_at: { sort: order, nulls: "last" },
      }),
    },
    // Newest first inside a tie; the id breaks what created_at cannot (routes
    // written in the same millisecond by a spreadsheet import).
    tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
  };

interface RouteListFilters {
  businessId: string;
  /** Present for driver tokens: only their own routes, whatever else is asked. */
  scopeDriverId?: string;
  search?: string;
  /** The day, date-only (UTC midnight of the civil day). */
  scheduled_date?: Date;
  statuses?: RouteStatus[];
  driverIds?: string[];
  vehicleIds?: string[];
}

type RouteFacet = "status" | "driverId" | "vehicleId";

/**
 * The listing's `where`, optionally without one facet: a number broken down
 * by a facet is counted with the search and every OTHER facet, never its own
 * (the disjunctive rule of shared/pagination), so choosing "Em andamento"
 * filters the table while the other status cards stay whole.
 */
function routeListWhere(
  filters: RouteListFilters,
  { except }: { except?: RouteFacet } = {},
): Prisma.RouteWhereInput {
  const and: Prisma.RouteWhereInput[] = [];

  if (filters.scopeDriverId) and.push({ driverId: filters.scopeDriverId });

  if (filters.scheduled_date) {
    and.push({ scheduled_date: filters.scheduled_date });
  }

  if (except !== "status" && filters.statuses?.length) {
    and.push({ status: { in: filters.statuses } });
  }

  if (except !== "driverId" && filters.driverIds?.length) {
    and.push({ driverId: { in: filters.driverIds } });
  }

  if (except !== "vehicleId" && filters.vehicleIds?.length) {
    and.push({ vehicleId: { in: filters.vehicleIds } });
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    const code = routeCodeFromSearch(term);

    and.push(
      buildSearchOr<Prisma.RouteWhereInput>([
        // The id the board shows (its tail) or copies (whole): see
        // shared/pagination/id-search. Nothing for a term not shaped like one.
        ...idSearchConditions(term),
        { name: { contains: term, mode: "insensitive" } },
        { destination: { contains: term, mode: "insensitive" } },
        { driver: { name: { contains: term, mode: "insensitive" } } },
        // Spread of an ARRAY, never of an object (see shared/pagination/
        // search-or). Only a term that names a code within the INTEGER
        // column: a pasted NF-e key used to reach Prisma as 4.4e43 and 500.
        ...(code !== null ? [{ code }] : []),
      ]),
    );
  }

  // The tenant stays a top-level key: route_businessId_* indexes serve it.
  return {
    businessId: filters.businessId,
    ...(and.length > 0 && { AND: and }),
  };
}

/** Count per value of one facet, as the repository groups it. */
interface GroupCount {
  value: string | null;
  count: number;
}

interface RouteListSearchMeta {
  /** Cards: every filter except the status facet; the five statuses always. */
  statusCounts: Record<RouteStatus, number>;
  facets: {
    status: FacetCount[];
    driverId: FacetCount[];
    vehicleId: FacetCount[];
  };
}

interface CatalogOption {
  value: string;
  label: string;
  count: number;
}

/**
 * Options of a catalog facet: every value with rows plus every selected
 * value (count 0 when it brings nothing now, so its chip keeps a name),
 * ordered by label. `labels` holds only the company's own records, so an id
 * of another tenant never gets a name back.
 */
function catalogFacetOptions(
  groups: GroupCount[],
  selected: string[] | undefined,
  labels: Map<string, string>,
): CatalogOption[] {
  const counts = new Map<string, number>();

  for (const group of groups) {
    if (group.value) counts.set(group.value, group.count);
  }

  return [...new Set([...counts.keys(), ...(selected ?? [])])]
    .filter((value) => labels.has(value))
    .map((value) => ({
      value,
      label: labels.get(value)!,
      count: counts.get(value) ?? 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

/**
 * The pager total, the status cards and the filter options, from the grouped
 * counts. Exact: the rows matching every facet are the status groups (counted
 * with every other facet) that the status facet keeps.
 */
function summarizeRouteList(
  statusGroups: GroupCount[],
  filters: Pick<RouteListFilters, "statuses">,
  options: { drivers: CatalogOption[]; vehicles: CatalogOption[] },
): { total: number; searchMeta: RouteListSearchMeta } {
  const statusCounts = Object.fromEntries(
    ROUTE_LIST_STATUSES.map((status) => [
      status,
      statusGroups.find((group) => group.value === status)?.count ?? 0,
    ]),
  ) as Record<RouteStatus, number>;

  const kept = filters.statuses?.length
    ? new Set<string>(filters.statuses)
    : null;

  const total = ROUTE_LIST_STATUSES.filter(
    (status) => !kept || kept.has(status),
  ).reduce((sum, status) => sum + statusCounts[status], 0);

  return {
    total,
    searchMeta: {
      statusCounts,
      facets: {
        status: ROUTE_LIST_STATUSES.map((value) => ({
          value,
          count: statusCounts[value],
        })),
        driverId: options.drivers,
        vehicleId: options.vehicles,
      },
    },
  };
}

export {
  ROUTE_LIST_STATUSES,
  ROUTE_SORT,
  ROUTE_SORT_FALLBACK,
  ROUTE_SORT_KEYS,
  catalogFacetOptions,
  routeListWhere,
  summarizeRouteList,
  type CatalogOption,
  type GroupCount,
  type RouteFacet,
  type RouteListFilters,
  type RouteListSearchMeta,
  type RouteSortKey,
};
