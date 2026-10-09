import type { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { sumCounts, type FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

/**
 * The fines list on the server-side table contract (decision 8.8): what it
 * sorts by, what it filters by, the payment status of a fine and how the
 * cards and filter counts are derived for the whole company. The web screen
 * used to count "Pagas" and "Pendentes" over the ten rows it held.
 */

/** Same ids as the web table's columns, so the URL `sort` value is the column id. */
const FINE_SORT_KEYS = [
  "created_at",
  "updated_at",
  "violation_date",
  "due_date",
  "payment_date",
  "amount",
  "points",
  "violationCode",
  "driverName",
  "vehicleLicensePlate",
  "branchName",
] as const;

type FineSortKey = (typeof FINE_SORT_KEYS)[number];

const FINE_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

type FineOrderBy = Prisma.FineOrderByWithRelationInput;

const FINE_SORT: SortSpec<FineSortKey, FineOrderBy> = {
  keys: FINE_SORT_KEYS,
  fallback: FINE_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    updated_at: (order: SortOrder) => ({ updated_at: order }),
    violation_date: (order: SortOrder) => ({ violation_date: order }),
    due_date: (order: SortOrder) => ({ due_date: order }),
    // Unpaid fines last in both directions: "sorted by payment" is about
    // the ones that have one.
    payment_date: (order: SortOrder) => ({
      payment_date: { sort: order, nulls: "last" },
    }),
    amount: (order: SortOrder) => ({ amount: order }),
    points: (order: SortOrder) => ({ points: order }),
    violationCode: (order: SortOrder) => ({
      trafficViolationCode: { code: order },
    }),
    driverName: (order: SortOrder) => ({ driver: { name: order } }),
    vehicleLicensePlate: (order: SortOrder) => ({
      vehicle: { license_plate: order },
    }),
    branchName: (order: SortOrder) => ({ branch: { corporate_reason: order } }),
  },
  // Newest first inside a tie; the id breaks what created_at cannot. Without
  // it OFFSET paging repeats or skips rows with equal values.
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

/**
 * Where a fine stands with its payment, on the company's business day.
 *
 * PAID: a payment date is recorded. OVERDUE: unpaid and the due day is
 * over — a fine due today can still be paid today, so it is overdue from
 * the next day on. PENDING: unpaid and still within the due day.
 */
const FINE_STATUSES = ["PAID", "PENDING", "OVERDUE"] as const;

type FineStatus = (typeof FINE_STATUSES)[number];

/** The facets: query param = the column the row carries. */
const FINE_FACETS = ["status", "branchId", "trafficViolationCodeId"] as const;

type FineFacet = (typeof FINE_FACETS)[number];

type IdFacet = Exclude<FineFacet, "status">;

interface FineListFilters {
  businessId: string;
  search?: string;
  statuses?: FineStatus[];
  branchIds?: string[];
  trafficViolationCodeIds?: string[];
}

type FineFacetSelection = Pick<
  FineListFilters,
  "statuses" | "branchIds" | "trafficViolationCodeIds"
>;

/**
 * The status of one fine. `todayStart` is the first instant of the
 * company's current business day (businessDayRange(now, zone).start).
 */
function fineStatus(
  fine: { payment_date?: Date | string | null; due_date: Date | string },
  todayStart: Date,
): FineStatus {
  if (fine.payment_date) return "PAID";

  return new Date(fine.due_date).getTime() < todayStart.getTime()
    ? "OVERDUE"
    : "PENDING";
}

/** The same rule as fineStatus, as a `where`: the filter and the counts agree. */
function fineStatusWhere(
  status: FineStatus,
  todayStart: Date,
): Prisma.FineWhereInput {
  if (status === "PAID") return { payment_date: { not: null } };

  return status === "OVERDUE"
    ? { payment_date: null, due_date: { lt: todayStart } }
    : { payment_date: null, due_date: { gte: todayStart } };
}

function selectedIds(
  filters: FineFacetSelection,
  facet: IdFacet,
): string[] | undefined {
  const values =
    facet === "branchId" ? filters.branchIds : filters.trafficViolationCodeIds;

  return values && values.length > 0 ? values : undefined;
}

/** Selected statuses, or undefined when the selection keeps every row. */
function selectedStatuses(filters: FineFacetSelection): FineStatus[] | undefined {
  const selected = Array.from(new Set(filters.statuses ?? []));

  return selected.length > 0 && selected.length < FINE_STATUSES.length
    ? selected
    : undefined;
}

// Codes are shown as "745-50"; the database keeps the two parts apart.
const FULL_CODE = /^(\d{1,6})-(\d{1,4})$/;

// A money value as typed: "293", "293,47", "293.47".
const MONEY = /^\d{1,8}(?:[.,]\d{1,2})?$/;

/**
 * The search term as a `where`, the same for the list and the export
 * (decision 5.8). The ids are there because the row menu copies them, and
 * the notification links to the list searching by the fine's id. The term
 * reaches Prisma through buildSearchOr, which makes `%` and `_` literal.
 */
function fineSearchWhere(term: string): Prisma.FineWhereInput {
  const contains = { contains: term, mode: "insensitive" as const };

  const conditions: Prisma.FineWhereInput[] = [
    { id: contains },
    { branchId: contains },
    { driverId: contains },
    { vehicleId: contains },
    { location: contains },
    { observation: contains },
    { driver: { OR: [{ name: contains }, { cpf: contains }] } },
    {
      vehicle: {
        OR: [{ license_plate: contains }, { description: contains }],
      },
    },
    {
      trafficViolationCode: {
        OR: [{ code: contains }, { description: contains }],
      },
    },
    { branch: { corporate_reason: contains } },
  ];

  const fullCode = FULL_CODE.exec(term);

  if (fullCode) {
    conditions.push({
      trafficViolationCode: {
        code: fullCode[1],
        sub_code: Number(fullCode[2]),
      },
    });
  }

  if (MONEY.test(term)) {
    conditions.push({ amount: { equals: new Decimal(term.replace(",", ".")) } });
  }

  return buildSearchOr(conditions);
}

/**
 * The list's `where`.
 *
 * `withFacets: false` is the base the counts are grouped over: branch and
 * code are columns of the row and the status is one of three disjoint
 * conditions, so one GROUP BY per status over this base yields the pager,
 * the cards and every filter's options (see summarizeFineList).
 */
function fineListWhere(
  filters: FineListFilters,
  { withFacets, todayStart }: { withFacets: boolean; todayStart: Date },
): Prisma.FineWhereInput {
  const and: Prisma.FineWhereInput[] = [];

  if (withFacets) {
    const branchIds = selectedIds(filters, "branchId");
    const codeIds = selectedIds(filters, "trafficViolationCodeId");
    const statuses = selectedStatuses(filters);

    if (branchIds) and.push({ branchId: { in: branchIds } });
    if (codeIds) and.push({ trafficViolationCodeId: { in: codeIds } });

    if (statuses) {
      and.push({
        OR: statuses.map((status) => fineStatusWhere(status, todayStart)),
      });
    }
  }

  const term = filters.search?.trim() ?? "";

  if (term) and.push(fineSearchWhere(term));

  // The tenant stays a top-level key: the (businessId, created_at) index
  // serves every read, and no OR can widen past it.
  return { businessId: filters.businessId, ...(and.length > 0 && { AND: and }) };
}

/** Fines of one (status, branch, code) combination over the base. */
interface FineListGroup {
  status: FineStatus;
  branchId: string;
  trafficViolationCodeId: string;
  count: number;
  /** Decimal string: money is not added in floating point. */
  amount: string;
}

/** Names of the catalog rows the options point at. */
type FineListLabels = Record<IdFacet, Record<string, string>>;

interface FineListSearchMeta {
  /** Cards: every filter except the status one, so the breakdown stays whole. */
  total: number;
  paid: number;
  pending: number;
  overdue: number;
  /** Sum of the amounts of those fines. */
  totalAmount: number;
  /** Of which unpaid (pending + overdue). */
  openAmount: number;
  facets: Record<FineFacet, FacetCount[]>;
}

function keptBy(
  group: FineListGroup,
  filters: FineFacetSelection,
  except?: FineFacet,
): boolean {
  return FINE_FACETS.every((facet) => {
    if (facet === except) return true;

    if (facet === "status") {
      const statuses = selectedStatuses(filters);

      return !statuses || statuses.includes(group.status);
    }

    const selected = selectedIds(filters, facet);

    return !selected || selected.includes(group[facet]);
  });
}

function sumAmounts(groups: FineListGroup[]): number {
  const total = groups.reduce(
    (sum, group) => sum.plus(new Decimal(group.amount)),
    new Decimal(0),
  );

  return Number(total.toFixed(2));
}

/**
 * The pager total, the cards and the options of each filter, from the groups.
 *
 * Disjunctive rule (table-infra contract): a number broken down by a facet
 * is counted with the search and every OTHER facet applied, never its own —
 * picking "Vencidas" narrows the table without turning "Pagas" into zero. A
 * selected option with no rows now stays listed with 0 so its chip keeps a
 * name, but only when the catalog names it: an id of another company's
 * branch gets neither a row nor a label.
 */
function summarizeFineList(
  groups: FineListGroup[],
  labels: FineListLabels,
  filters: FineFacetSelection,
): { total: number; searchMeta: FineListSearchMeta } {
  const cardGroups = groups.filter((group) => keptBy(group, filters, "status"));

  const countOf = (status: FineStatus) =>
    sumCounts(cardGroups.filter((group) => group.status === status));

  const idOptions = (facet: IdFacet): FacetCount[] => {
    const counts = new Map<string, number>();

    for (const group of groups) {
      if (!keptBy(group, filters, facet)) continue;

      counts.set(group[facet], (counts.get(group[facet]) ?? 0) + group.count);
    }

    for (const value of selectedIds(filters, facet) ?? []) {
      if (!counts.has(value)) counts.set(value, 0);
    }

    return Array.from(counts.entries())
      .filter(([value]) => labels[facet][value] !== undefined)
      .map(([value, count]) => ({ value, label: labels[facet][value], count }))
      .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  };

  const paid = countOf("PAID");
  const pending = countOf("PENDING");
  const overdue = countOf("OVERDUE");

  return {
    total: sumCounts(groups.filter((group) => keptBy(group, filters))),
    searchMeta: {
      total: paid + pending + overdue,
      paid,
      pending,
      overdue,
      totalAmount: sumAmounts(cardGroups),
      openAmount: sumAmounts(
        cardGroups.filter((group) => group.status !== "PAID"),
      ),
      facets: {
        status: FINE_STATUSES.map((status) => ({
          value: status,
          count: countOf(status),
        })),
        branchId: idOptions("branchId"),
        trafficViolationCodeId: idOptions("trafficViolationCodeId"),
      },
    },
  };
}

/** Every id the options may name: those with rows plus the selected ones. */
function labelIdsOf(
  groups: FineListGroup[],
  filters: FineFacetSelection,
): Record<IdFacet, string[]> {
  const collect = (facet: IdFacet) =>
    Array.from(
      new Set([
        ...groups.map((group) => group[facet]),
        ...(selectedIds(filters, facet) ?? []),
      ]),
    );

  return {
    branchId: collect("branchId"),
    trafficViolationCodeId: collect("trafficViolationCodeId"),
  };
}

/** How a code reads in the filter and in the row: "745-50". */
function fullViolationCode(code: { code: string; sub_code: number }): string {
  return `${code.code}-${code.sub_code}`;
}

export {
  FINE_FACETS,
  FINE_SORT,
  FINE_SORT_FALLBACK,
  FINE_SORT_KEYS,
  FINE_STATUSES,
  fineListWhere,
  fineSearchWhere,
  fineStatus,
  fineStatusWhere,
  fullViolationCode,
  labelIdsOf,
  selectedStatuses,
  summarizeFineList,
  type FineFacet,
  type FineListFilters,
  type FineListGroup,
  type FineListLabels,
  type FineListSearchMeta,
  type FineSortKey,
  type FineStatus,
};
