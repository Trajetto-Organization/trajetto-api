import type { Prisma } from "@prisma/client";
import { isDeepStrictEqual } from "node:util";

import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import type { DeliveryKind } from "@/shared/delivery/delivery-kind";
import { buildSearchOr } from "@/shared/pagination/search-or";

import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

/**
 * The deliveries table on the server (decisions 5.8 and 8.8): what it sorts
 * by, what it filters by, the cards and the filter counts — and the same
 * `where` for the export, so the file is what the screen shows.
 */

const DELIVERY_LIST_STATUSES = [
  "PENDING",
  "IN_TRANSIT",
  "DELIVERED",
  "FAILED",
  "CANCELLED",
] as const satisfies readonly DeliveryStatus[];

/** Same ids as the web table's columns: the URL value is the column id. */
const DELIVERY_SORT_KEYS = [
  "created_at",
  "updated_at",
  "recipient_name",
  "status",
  "scheduled_date",
  "delivered_at",
  "shipperName",
  "driverName",
  "destination",
] as const;

type DeliverySortKey = (typeof DELIVERY_SORT_KEYS)[number];

const DELIVERY_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

const DELIVERY_SORT: SortSpec<
  DeliverySortKey,
  Prisma.DeliveryOrderByWithRelationInput
> = {
  keys: DELIVERY_SORT_KEYS,
  fallback: DELIVERY_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    updated_at: (order: SortOrder) => ({ updated_at: order }),
    recipient_name: (order: SortOrder) => ({ recipient_name: order }),
    status: (order: SortOrder) => ({ status: order }),
    // A null date sorts last either way: "sem data" is not the earliest day.
    scheduled_date: (order: SortOrder) => ({
      scheduled_date: { sort: order, nulls: "last" },
    }),
    delivered_at: (order: SortOrder) => ({
      delivered_at: { sort: order, nulls: "last" },
    }),
    shipperName: (order: SortOrder) => ({ shipper: { name: order } }),
    driverName: (order: SortOrder) => ({ driver: { name: order } }),
    destination: (order: SortOrder) => ({ city: order }),
  },
  // Newest first inside a tie; the id breaks what created_at cannot (a batch
  // written in one millisecond by an import).
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface DeliveryListFilters {
  businessId: string;
  /** Present for driver tokens: only the deliveries they carry. */
  scopeDriverId?: string;
  search?: string;
  statuses?: DeliveryStatus[];
  shipperIds?: string[];
  driverIds?: string[];
  kinds?: DeliveryKind[];
  /**
   * The period (delivery-period.ts), already resolved in the company's zone:
   * created_at >= createdFrom AND created_at < createdTo. Absent = every date.
   */
  createdFrom?: Date;
  createdTo?: Date;
}

type DeliveryFacet = "status" | "shipperId" | "driverId";

/**
 * The listing's `where`, optionally without one facet: a number broken down
 * by a facet is counted with the search and every OTHER facet, never its own
 * (the disjunctive rule of shared/pagination), so choosing "Entregue" filters
 * the table while the other status counts stay whole.
 */
function deliveryListWhere(
  filters: DeliveryListFilters & {
    ids?: readonly string[];
    matchedDriverIds?: readonly string[];
  },
  { except }: { except?: DeliveryFacet } = {},
): Prisma.DeliveryWhereInput {
  const and: Prisma.DeliveryWhereInput[] = [];

  if (filters.scopeDriverId) {
    and.push({ driverId: filters.scopeDriverId });
  }

  // The period: a range of the (businessId, created_at) index, the same
  // column the default order walks.
  if (filters.createdFrom || filters.createdTo) {
    and.push({
      created_at: {
        ...(filters.createdFrom && { gte: filters.createdFrom }),
        ...(filters.createdTo && { lt: filters.createdTo }),
      },
    });
  }

  // The search already resolved to the rows it matches (the repository's
  // trigram read, see delivery-search.ts): those ids, or a delivery of a
  // driver it matched by name or CNH (uncapped, served by the driverId index).
  if (filters.ids) {
    const driverIds = filters.matchedDriverIds ?? [];

    and.push(
      driverIds.length
        ? {
            OR: [
              { id: { in: [...filters.ids] } },
              { driverId: { in: [...driverIds] } },
            ],
          }
        : { id: { in: [...filters.ids] } },
    );
  }

  if (except !== "status" && filters.statuses?.length) {
    and.push({ status: { in: filters.statuses } });
  }

  if (except !== "shipperId" && filters.shipperIds?.length) {
    and.push({ shipperId: { in: filters.shipperIds } });
  }

  if (except !== "driverId" && filters.driverIds?.length) {
    and.push({ driverId: { in: filters.driverIds } });
  }

  // Not a counted facet: it narrows every count, like the search.
  if (filters.kinds?.length) {
    and.push({ kind: { in: filters.kinds } });
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    and.push(
      buildSearchOr<Prisma.DeliveryWhereInput>([
        // The id is copiable from the row menu, so pasting it must find it.
        { id: { contains: term, mode: "insensitive" } },
        { recipient_name: { contains: term, mode: "insensitive" } },
        { code: { contains: term, mode: "insensitive" } },
        { invoice_key: { contains: term, mode: "insensitive" } },
        { invoice_number: { contains: term, mode: "insensitive" } },
        { city: { contains: term, mode: "insensitive" } },
        // Homonymous drivers are told apart by CNH.
        { driver: { name: { contains: term, mode: "insensitive" } } },
        { driver: { cnh: { contains: term, mode: "insensitive" } } },
      ]),
    );
  }

  // The tenant stays a top-level key: the (businessId, …) indexes serve
  // every read of the listing.
  return {
    businessId: filters.businessId,
    ...(and.length > 0 && { AND: and }),
  };
}

/**
 * Whether the listing's `where` is only the tenant, a driver token's scope
 * and the period. Then every facet count shares that one `where` and the
 * repository may answer them with a single GROUPING SETS read that rebuilds
 * just those predicates. Derived from the built `where` rather than a list of
 * filter fields, so a filter added to deliveryListWhere later turns the
 * shortcut off instead of being silently left out of the counts.
 */
function isTenantOnlyDeliveryList(
  filters: Parameters<typeof deliveryListWhere>[0],
): boolean {
  return isDeepStrictEqual(
    deliveryListWhere(filters),
    deliveryListWhere({
      businessId: filters.businessId,
      scopeDriverId: filters.scopeDriverId,
      createdFrom: filters.createdFrom,
      createdTo: filters.createdTo,
    }),
  );
}

/** Count per value of one facet, as the repository groups it. */
interface GroupCount {
  value: string | null;
  count: number;
}

/**
 * The period the numbers cover, in the company's zone, so the screen labels
 * the range with the server's days rather than the browser's.
 */
interface DeliveryListPeriodMeta {
  from: string;
  to: string;
  /**
   * False when the search was exactly a delivery's id, order code, NF-e key
   * or NF number: then the period is ignored and the rows may be older.
   */
  applied: boolean;
}

interface DeliveryListSearchMeta {
  /** Cards: every filter except the status facet. */
  statusCounts: Record<string, number>;
  facets: {
    status: FacetCount[];
    shipperId: FacetCount[];
    driverId: FacetCount[];
  };
  /** Null when no period was asked for (every date). */
  period?: DeliveryListPeriodMeta | null;
}

/**
 * The pager total, the status cards and the filter options, from the grouped
 * counts. Exact: the rows matching every facet are the status groups (counted
 * with every other facet) that the status facet keeps.
 */
function summarizeDeliveryList(
  statusCounts: GroupCount[],
  filters: Pick<DeliveryListFilters, "statuses">,
  options: {
    shippers: Array<{ value: string; label: string; count: number }>;
    drivers: Array<{ value: string; label: string; count: number }>;
  },
): { total: number; searchMeta: DeliveryListSearchMeta } {
  const byStatus: Record<string, number> = {};

  for (const group of statusCounts) {
    if (group.value) byStatus[group.value] = group.count;
  }

  const kept = filters.statuses?.length
    ? new Set<string>(filters.statuses)
    : null;

  const total = Object.entries(byStatus)
    .filter(([status]) => !kept || kept.has(status))
    .reduce((sum, [, count]) => sum + count, 0);

  return {
    total,
    searchMeta: {
      statusCounts: byStatus,
      facets: {
        status: DELIVERY_LIST_STATUSES.map((value) => ({
          value,
          count: byStatus[value] ?? 0,
        })),
        shipperId: options.shippers,
        driverId: options.drivers,
      },
    },
  };
}

/**
 * Facet options for a catalog facet: every value with rows, plus every
 * selected value (count 0 when it brings nothing now, so its chip keeps a
 * name), ordered by label. `labels` holds only the company's own records, so
 * an id of another tenant never gets a name back.
 */
function catalogFacetOptions(
  groups: GroupCount[],
  selected: string[] | undefined,
  labels: Map<string, string>,
): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<string, number>();

  for (const group of groups) {
    if (group.value) counts.set(group.value, group.count);
  }

  const values = new Set([...counts.keys(), ...(selected ?? [])]);

  return [...values]
    .filter((value) => labels.has(value))
    .map((value) => ({
      value,
      label: labels.get(value)!,
      count: counts.get(value) ?? 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

export {
  DELIVERY_LIST_STATUSES,
  DELIVERY_SORT,
  DELIVERY_SORT_FALLBACK,
  DELIVERY_SORT_KEYS,
  catalogFacetOptions,
  deliveryListWhere,
  isTenantOnlyDeliveryList,
  summarizeDeliveryList,
  type DeliveryFacet,
  type DeliveryListFilters,
  type DeliveryListPeriodMeta,
  type DeliveryListSearchMeta,
  type DeliverySortKey,
  type GroupCount,
};
