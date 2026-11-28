import type { FuelAlert, Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { sumCounts, type FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

/**
 * The refuelings list on the server-side table contract (decision 8.8): what
 * it sorts by, what it filters by, and how the cards and filter counts are
 * derived for the whole company — never from the page the screen holds.
 */

/** Same ids as the web table's columns, so the URL `sort` value is the column id. */
const FUEL_SORT_KEYS = [
  "created_at",
  "refueling_date",
  "updated_at",
  "current_mileage",
  "liters_amount",
  "price_per_liter",
  "total_amount",
  "vehicle_license_plate",
  "driver_name",
  "fuel_type_description",
  "branchName",
] as const;

type FuelSortKey = (typeof FUEL_SORT_KEYS)[number];

const FUEL_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

type FuelOrderBy = Prisma.FuelOrderByWithRelationInput;

const FUEL_SORT: SortSpec<FuelSortKey, FuelOrderBy> = {
  keys: FUEL_SORT_KEYS,
  fallback: FUEL_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    refueling_date: (order: SortOrder) => ({ refueling_date: order }),
    updated_at: (order: SortOrder) => ({ updated_at: order }),
    current_mileage: (order: SortOrder) => ({ current_mileage: order }),
    liters_amount: (order: SortOrder) => ({ liters_amount: order }),
    price_per_liter: (order: SortOrder) => ({ price_per_liter: order }),
    total_amount: (order: SortOrder) => ({ total_amount: order }),
    vehicle_license_plate: (order: SortOrder) => ({
      vehicle: { license_plate: order },
    }),
    driver_name: (order: SortOrder) => ({ driver: { name: order } }),
    fuel_type_description: (order: SortOrder) => ({
      fuelType: { description: order },
    }),
    branchName: (order: SortOrder) => ({ branch: { corporate_reason: order } }),
  },
  // Newest first inside a tie; the id breaks what created_at cannot. Without
  // it OFFSET paging repeats or skips rows with equal values.
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

/** The facets: query param = the record's foreign key. */
const FUEL_FACETS = ["branchId", "vehicleId", "fuelTypeId"] as const;

type FuelFacet = (typeof FUEL_FACETS)[number];

/**
 * The alerts a refuelling can carry (the FuelAlert enum, 20261105130000):
 * the `alerts` facet, a closed set the web labels. A record with several
 * counts under each; the filter keeps a record with ANY of the selected.
 */
const FUEL_ALERTS = ["RECENT_REFUEL"] as const satisfies readonly FuelAlert[];

/** Every facet's query param: the catalog ones and `alerts`. */
type FuelFilterFacet = FuelFacet | "alerts";

interface FuelListFilters {
  businessId: string;
  /** Present for driver tokens: only their own refuelings (decision 4.4). */
  driverId?: string;
  search?: string;
  branchIds?: string[];
  vehicleIds?: string[];
  fuelTypeIds?: string[];
  /** Records having any of these alerts (05/11/2026). */
  alerts?: FuelAlert[];
}

/** What the facets read of the filters. */
type FuelFacetFilters = Pick<
  FuelListFilters,
  "branchIds" | "vehicleIds" | "fuelTypeIds" | "alerts"
>;

function selectedOf(
  filters: FuelFacetFilters,
  facet: FuelFacet,
): string[] | undefined {
  const values =
    facet === "branchId"
      ? filters.branchIds
      : facet === "vehicleId"
        ? filters.vehicleIds
        : filters.fuelTypeIds;

  return values && values.length > 0 ? values : undefined;
}

/** The alerts the filter selects, or undefined when it selects none. */
function selectedAlerts(filters: FuelFacetFilters): FuelAlert[] | undefined {
  return filters.alerts && filters.alerts.length > 0
    ? filters.alerts
    : undefined;
}

/** Whether a record's alerts pass the selection: any of the selected. */
function hasSelectedAlert(
  alerts: ReadonlyArray<FuelAlert>,
  selected: ReadonlyArray<FuelAlert> | undefined,
): boolean {
  return !selected || alerts.some((alert) => selected.includes(alert));
}

/**
 * The search term's `where`, the same for the list, the export (decision
 * 5.8) and a vehicle's history. The ids are there because the row menu
 * copies them. Escaped here, through buildSearchOr, so a `%` or `_` the
 * person typed is literal wherever the term is used.
 */
function fuelSearchWhere(term: string): Prisma.FuelWhereInput {
  const contains = { contains: term, mode: "insensitive" as const };

  const conditions: Prisma.FuelWhereInput[] = [
    { id: contains },
    { notes: contains },
    {
      vehicle: {
        OR: [
          { license_plate: contains },
          { description: contains },
          { brand: contains },
          { model: contains },
        ],
      },
    },
    { driver: { OR: [{ name: contains }, { cnh: contains }] } },
    { fuelType: { description: contains } },
    { branch: { corporate_reason: contains } },
  ];

  return buildSearchOr(conditions);
}

/**
 * The list's `where`. `withFacets: false` is the base the counts are grouped
 * over: every facet is a column of the row, so one GROUP BY over this base
 * yields the pager total, the cards and each filter's options (see
 * summarizeFuelList) without a scan per facet.
 */
function fuelListWhere(
  filters: FuelListFilters,
  { withFacets }: { withFacets: boolean },
): Prisma.FuelWhereInput {
  const and: Prisma.FuelWhereInput[] = [];

  if (filters.driverId) and.push({ driverId: filters.driverId });

  if (withFacets) {
    const branchIds = selectedOf(filters, "branchId");
    const vehicleIds = selectedOf(filters, "vehicleId");
    const fuelTypeIds = selectedOf(filters, "fuelTypeId");
    const alerts = selectedAlerts(filters);

    if (branchIds) and.push({ branchId: { in: branchIds } });
    if (vehicleIds) and.push({ vehicleId: { in: vehicleIds } });
    if (fuelTypeIds) and.push({ fuelTypeId: { in: fuelTypeIds } });
    // `&&` on the array: a record with any of the selected alerts.
    if (alerts) and.push({ alerts: { hasSome: alerts } });
  }

  const term = filters.search?.trim() ?? "";

  if (term) and.push(fuelSearchWhere(term));

  // The tenant stays a top-level key: the (businessId, created_at) index
  // serves every read, and no OR can widen past it.
  return {
    businessId: filters.businessId,
    ...(and.length > 0 && { AND: and }),
  };
}

/** Refuelings of one combination of the facet columns, over the base. */
interface FuelListGroup {
  branchId: string;
  vehicleId: string;
  fuelTypeId: string;
  odometer_verified: boolean;
  /** The records' alerts, grouped as the array they store ([] for none). */
  alerts: FuelAlert[];
  count: number;
  /** Sums as decimal strings: money is not added in floating point. */
  liters: string;
  amount: string;
}

/** Names of the catalog rows the options point at, read inside the company. */
type FuelListLabels = Record<FuelFacet, Record<string, string>>;

interface FuelListSearchMeta {
  /** Refuelings of the search and every filter (the cards ignore paging). */
  total: number;
  totalLiters: number;
  totalAmount: number;
  verifiedOdometer: number;
  /**
   * The catalog facets (labelled, busiest first) and `alerts`: every
   * FUEL_ALERTS value with its count, unlabelled, like the checklist's
   * condition (the web names a closed set).
   */
  facets: Record<FuelFilterFacet, FacetCount[]>;
}

/**
 * Most options one filter offers. A fleet of thousands of vehicles put every
 * plate that ever refueled into the meta line of every page view, each one
 * looked up by name. The busiest come first and a selected option is always
 * kept (its chip needs a name); the search box still reaches any plate.
 */
const FUEL_FACET_OPTION_LIMIT = 100;

function keptBy(
  group: FuelListGroup,
  filters: FuelFacetFilters,
  except?: FuelFilterFacet,
): boolean {
  const alertsKept =
    except === "alerts" ||
    hasSelectedAlert(group.alerts, selectedAlerts(filters));

  return (
    alertsKept &&
    FUEL_FACETS.every((facet) => {
      if (facet === except) return true;

      const selected = selectedOf(filters, facet);

      return !selected || selected.includes(group[facet]);
    })
  );
}

/**
 * The `alerts` facet under the disjunctive rule: per alert, the records
 * carrying it with every other filter applied. All of FUEL_ALERTS, zeros
 * included, in their order: a closed set the web labels.
 */
function alertCounts(
  groups: FuelListGroup[],
  filters: FuelFacetFilters,
): FacetCount[] {
  const others = groups.filter((group) => keptBy(group, filters, "alerts"));

  return FUEL_ALERTS.map((alert) => ({
    value: alert,
    count: sumCounts(others.filter((group) => group.alerts.includes(alert))),
  }));
}

/** A facet's counts under the disjunctive rule, selected options included. */
function facetCounts(
  groups: FuelListGroup[],
  filters: FuelFacetFilters,
  facet: FuelFacet,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const group of groups) {
    if (!keptBy(group, filters, facet)) continue;

    counts.set(group[facet], (counts.get(group[facet]) ?? 0) + group.count);
  }

  for (const value of selectedOf(filters, facet) ?? []) {
    if (!counts.has(value)) counts.set(value, 0);
  }

  return counts;
}

/**
 * The values a filter offers: every selected one, then the busiest up to
 * FUEL_FACET_OPTION_LIMIT (ties by id, so the cut is stable between calls).
 */
function offeredValues(
  groups: FuelListGroup[],
  filters: FuelFacetFilters,
  facet: FuelFacet,
): string[] {
  const selected = selectedOf(filters, facet) ?? [];

  const busiest = Array.from(facetCounts(groups, filters, facet).entries())
    .filter(([value]) => !selected.includes(value))
    .sort(
      ([leftValue, leftCount], [rightValue, rightCount]) =>
        rightCount - leftCount ||
        (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0),
    )
    .slice(0, Math.max(0, FUEL_FACET_OPTION_LIMIT - selected.length))
    .map(([value]) => value);

  return [...selected, ...busiest];
}

/**
 * The pager total, the cards and the options of each filter, from the groups.
 *
 * Disjunctive rule (table-infra contract): a facet's options are counted with
 * the search and every OTHER facet applied, never its own, so picking a
 * branch narrows the table without turning the other branches' counts into
 * zeros. A selected option that has no rows now stays listed with 0 so its
 * chip keeps a name — but only when the company's catalog names it: an id of
 * another company gets neither a row nor a label.
 */
function summarizeFuelList(
  groups: FuelListGroup[],
  labels: FuelListLabels,
  filters: FuelFacetFilters,
): { total: number; searchMeta: FuelListSearchMeta } {
  const kept = groups.filter((group) => keptBy(group, filters));

  const liters = kept.reduce(
    (sum, group) => sum.plus(new Decimal(group.liters)),
    new Decimal(0),
  );
  const amount = kept.reduce(
    (sum, group) => sum.plus(new Decimal(group.amount)),
    new Decimal(0),
  );

  const facetOptions = (facet: FuelFacet): FacetCount[] => {
    const counts = facetCounts(groups, filters, facet);

    return offeredValues(groups, filters, facet)
      .filter((value) => labels[facet][value] !== undefined)
      .map((value) => ({
        value,
        label: labels[facet][value],
        count: counts.get(value) ?? 0,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  };

  const total = sumCounts(kept);

  return {
    total,
    searchMeta: {
      total,
      totalLiters: Number(liters.toFixed(3)),
      totalAmount: Number(amount.toFixed(2)),
      verifiedOdometer: sumCounts(
        kept.filter((group) => group.odometer_verified),
      ),
      facets: {
        branchId: facetOptions("branchId"),
        vehicleId: facetOptions("vehicleId"),
        fuelTypeId: facetOptions("fuelTypeId"),
        alerts: alertCounts(groups, filters),
      },
    },
  };
}

/**
 * The ids whose names the options need: exactly the offered values, so the
 * name lookups are bounded like the options.
 */
function labelIdsOf(
  groups: FuelListGroup[],
  filters: FuelFacetFilters,
): Record<FuelFacet, string[]> {
  return {
    branchId: offeredValues(groups, filters, "branchId"),
    vehicleId: offeredValues(groups, filters, "vehicleId"),
    fuelTypeId: offeredValues(groups, filters, "fuelTypeId"),
  };
}

export {
  FUEL_ALERTS,
  FUEL_FACETS,
  FUEL_FACET_OPTION_LIMIT,
  FUEL_SORT,
  FUEL_SORT_FALLBACK,
  FUEL_SORT_KEYS,
  fuelListWhere,
  fuelSearchWhere,
  hasSelectedAlert,
  labelIdsOf,
  selectedAlerts,
  selectedOf,
  summarizeFuelList,
  type FuelFacet,
  type FuelFacetFilters,
  type FuelFilterFacet,
  type FuelListFilters,
  type FuelListGroup,
  type FuelListLabels,
  type FuelListSearchMeta,
  type FuelSortKey,
};
