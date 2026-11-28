import type { Prisma } from "@prisma/client";

import { idSearchConditions, idSearchOf } from "@/shared/pagination/id-search";
import { buildSearchOr } from "@/shared/pagination/search-or";
import {
  routeCodeFromSearch,
  type RouteStatus,
  type RouteStopStatus,
} from "@/shared/route/route-rules";
import {
  NOT_DEPARTED_STATUSES,
  type RouteListPeriodDays,
} from "@/shared/route/route-period";
import { dateOnlyFromKey, dateOnlyKey } from "@/shared/time/business-day";

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

/**
 * The order with a period and no `sort`: the route's day, the column the
 * period reads, latest first (then created_at desc, id desc).
 *
 * Newest created first was the order of a list of every date. Over a range
 * of days it cost the history: Postgres may walk route (businessId,
 * created_at DESC) from today and filter the range out of it, and the
 * planner prices that walk as if the range's rows were spread over the
 * whole index, when creation moves with the day and puts them all at its
 * far end — a custom March of last year read every route created since.
 * Ordered by the day, the page reads the period's own rows through route
 * (businessId, scheduled_date): backward from `to` for a past range, and
 * the top of the period's rows plus the unfinished ones (route-period) for
 * a period that reaches today. On Hoje nothing moves but the routes of
 * earlier days the period keeps, which go after today's.
 */
const ROUTE_PERIOD_SORT_FALLBACK = {
  sort: "scheduled_date",
  order: "desc",
} as const;

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

/** The same columns, for a listing with a period (ROUTE_PERIOD_SORT_FALLBACK). */
const ROUTE_PERIOD_SORT: typeof ROUTE_SORT = {
  ...ROUTE_SORT,
  fallback: ROUTE_PERIOD_SORT_FALLBACK,
};

interface RouteListFilters {
  businessId: string;
  /** Present for driver tokens: only their own routes, whatever else is asked. */
  scopeDriverId?: string;
  search?: string;
  /** The day, date-only (UTC midnight of the civil day). */
  scheduled_date?: Date;
  /**
   * The period (plan of 09/11/2026), already in the company's days
   * (shared/route/route-period): the routes of those days, and the running
   * and the overdue ones when it reaches today. Not a facet: every count
   * keeps it.
   */
  period?: RouteListPeriodDays;
  /**
   * The days the period's routes reach, read before the listing
   * (routeListUnfinishedWhere, routeListPeriodSpan): the period's own and
   * those of its running and overdue routes of other days. Every variant
   * keeps the read inside them, so the scan by the route's day stops there
   * instead of walking the company's history for a forgotten route that is
   * not there. Changes no answer: the period's routes are all inside it.
   */
  periodSpan?: { from: string; to: string };
  statuses?: RouteStatus[];
  driverIds?: string[];
  vehicleIds?: string[];
}

type RouteFacet = "status" | "driverId" | "vehicleId";

/**
 * The period's routes of other days: the running ones and, on the list, an
 * earlier day's route that never left. Both are served by route
 * (businessId, status, scheduled_date).
 */
function unfinishedArms(period: RouteListPeriodDays): Prisma.RouteWhereInput[] {
  return [
    ...(period.includesRunning ? [{ status: "IN_PROGRESS" as const }] : []),
    ...(period.includesOverdue
      ? [
          {
            status: { in: [...NOT_DEPARTED_STATUSES] },
            scheduled_date: { lt: dateOnlyFromKey(period.from) },
          },
        ]
      : []),
  ];
}

/**
 * The company's (and the driver's) routes of the period's unfinished arms,
 * whose earliest and latest days bound the listing (periodSpan); null when
 * the period has none. No search and no facet: the bound only has to hold
 * every route the listing could show.
 *
 * Why the bound: the page goes by the route's day, newest first, and
 * Postgres reads it down route (businessId, scheduled_date), filtering. Past
 * the period's days, a running route could be on any earlier day, so with
 * fewer rows than the page asks for — or just to close the last day's sort —
 * the scan walked the company's whole history (plan of 09/11/2026, the
 * query-plans case of Hoje). One probe of the status index tells how far
 * the forgotten routes really go.
 */
function routeListUnfinishedWhere(
  filters: RouteListFilters,
): Prisma.RouteWhereInput | null {
  if (!filters.period) return null;

  const arms = unfinishedArms(filters.period);

  if (arms.length === 0) return null;

  return {
    businessId: filters.businessId,
    ...(filters.scopeDriverId && { driverId: filters.scopeDriverId }),
    OR: arms,
  };
}

/**
 * The days the listing reads: the period's, widened to its unfinished routes'
 * earliest and latest (null when there is none).
 */
function routeListPeriodSpan(
  period: RouteListPeriodDays,
  earliest: Date | null,
  latest: Date | null,
): { from: string; to: string } {
  const first = earliest ? dateOnlyKey(earliest) : period.from;
  const last = latest ? dateOnlyKey(latest) : period.to;

  return {
    from: first < period.from ? first : period.from,
    to: last > period.to ? last : period.to,
  };
}

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

  // In every variant, `except` or not: the cards and the filter options
  // count the period on screen, never the company's history.
  if (filters.period) {
    const days: Prisma.RouteWhereInput = {
      scheduled_date: {
        gte: dateOnlyFromKey(filters.period.from),
        lte: dateOnlyFromKey(filters.period.to),
      },
    };

    const unfinished = unfinishedArms(filters.period);

    and.push(unfinished.length > 0 ? { OR: [days, ...unfinished] } : days);

    if (filters.periodSpan) {
      and.push({
        scheduled_date: {
          gte: dateOnlyFromKey(filters.periodSpan.from),
          lte: dateOnlyFromKey(filters.periodSpan.to),
        },
      });
    }
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
  /**
   * The company's zone, for the board's hours; written by the use case
   * (the repository's summary leaves it out).
   */
  timeZone?: string;
  /**
   * The days the page and the counts cover, null without a period (every
   * date); `applied` is false when an exact search ignored them. Written by
   * the use case, like the zone.
   */
  period?: { from: string; to: string; applied: boolean } | null;
}

/**
 * The one route a search names exactly — its whole id or its number ("12",
 * "Rota 12", "#12") — as the lookup that finds it, or null for a term that
 * names a set (a name, a destination, the id's tail).
 *
 * With a period, such a term is a question about THAT route, whatever its
 * day, as an exact id or order code is in Entregas (resolveDeliveryPeriod):
 * a link or a dispatcher saying "Rota 12" must find last month's route 12.
 * The lookup is by the primary key or the (businessId, code) unique key.
 */
function exactRouteSearch(
  term: string | undefined,
): { id: string } | { code: number } | null {
  const trimmed = term?.trim() ?? "";

  if (!trimmed) return null;

  const id = idSearchOf(trimmed);

  if (id?.kind === "exact") return { id: id.id };

  const code = routeCodeFromSearch(trimmed);

  return code !== null ? { code } : null;
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

/** Every stop status, in the enum's declared order. */
const ROUTE_STOP_STATUSES: readonly RouteStopStatus[] = [
  "PENDING",
  "ARRIVED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

/**
 * A board row's stops, counted by status (plan of 02/11/2026, K14), from the
 * repository's groupBy(routeId, status) — or from the twin's own stops.
 * Every status is present, zeros included, so the web never guesses a key.
 */
function stopCountsOf(
  groups: ReadonlyArray<{ status: RouteStopStatus; count: number }>,
): Record<RouteStopStatus, number> {
  const counts = Object.fromEntries(
    ROUTE_STOP_STATUSES.map((status) => [status, 0]),
  ) as Record<RouteStopStatus, number>;

  for (const group of groups) counts[group.status] += group.count;

  return counts;
}

export {
  ROUTE_LIST_STATUSES,
  ROUTE_STOP_STATUSES,
  ROUTE_PERIOD_SORT,
  ROUTE_PERIOD_SORT_FALLBACK,
  ROUTE_SORT,
  ROUTE_SORT_FALLBACK,
  ROUTE_SORT_KEYS,
  catalogFacetOptions,
  exactRouteSearch,
  routeListPeriodSpan,
  routeListUnfinishedWhere,
  routeListWhere,
  stopCountsOf,
  summarizeRouteList,
  type CatalogOption,
  type GroupCount,
  type RouteFacet,
  type RouteListFilters,
  type RouteListSearchMeta,
  type RouteSortKey,
};
