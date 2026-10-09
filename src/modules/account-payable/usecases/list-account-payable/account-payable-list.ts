import type { AccountPayableCategory, Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

import {
  ACCOUNT_PAYABLE_STATUS_GROUPS,
  type AccountPayableStatusGroup,
} from "../../rules/account-payable-status";

/**
 * The accounts payable list's server-side table (decision 8.8): what it
 * sorts by, what it filters by and how the cards are counted. The export
 * reads the same `where`, so a file never holds rows the screen did not
 * show (decision 5.8).
 */

const ACCOUNT_PAYABLE_CATEGORIES = [
  "FUEL",
  "MAINTENANCE",
  "INSURANCE",
  "TAXES_FEES",
  "FINES",
  "TOLLS",
  "RENTAL",
  "PAYROLL",
  "OTHER",
] as const satisfies readonly AccountPayableCategory[];

/** Same ids as the web table's columns, so the URL value is the column id. */
const ACCOUNT_PAYABLE_SORT_KEYS = [
  "created_at",
  "issue_date",
  "due_date",
  "payment_date",
  "amount",
  "amount_paid",
  "category",
  "supplier",
  "vehicle",
] as const;

type AccountPayableSortKey = (typeof ACCOUNT_PAYABLE_SORT_KEYS)[number];

const ACCOUNT_PAYABLE_SORT_FALLBACK = {
  sort: "created_at",
  order: "desc",
} as const;

type OrderBy = Prisma.AccountPayableOrderByWithRelationInput;

/**
 * The status is computed, so it is not a sort key (table-infra contract):
 * sorting by due date gives the same reading without pretending the database
 * orders by a label.
 */
const ACCOUNT_PAYABLE_SORT: SortSpec<AccountPayableSortKey, OrderBy> = {
  keys: ACCOUNT_PAYABLE_SORT_KEYS,
  fallback: ACCOUNT_PAYABLE_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    issue_date: (order: SortOrder) => ({ issue_date: order }),
    due_date: (order: SortOrder) => ({ due_date: order }),
    // Unpaid bills last in both directions: "most recently paid" should not
    // open on a page of blanks.
    payment_date: (order: SortOrder) => ({
      payment_date: { sort: order, nulls: "last" },
    }),
    amount: (order: SortOrder) => ({ amount: order }),
    amount_paid: (order: SortOrder) => ({
      amount_paid: { sort: order, nulls: "last" },
    }),
    category: (order: SortOrder) => ({
      category: { sort: order, nulls: "last" },
    }),
    supplier: (order: SortOrder) => ({ supplier: { name: order } }),
    vehicle: (order: SortOrder) => ({ vehicle: { license_plate: order } }),
  },
  // Newest first inside a tie; the id breaks what created_at cannot.
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface AccountPayableListFilters {
  businessId: string;
  search?: string;
  statusGroups?: AccountPayableStatusGroup[];
  categories?: AccountPayableCategory[];
}

type AmountRef = Prisma.FieldRef<"AccountPayable", "Decimal">;

/**
 * One situation as a `where`, over the same comparisons as
 * accountPayableStatusOf: fully paid is `amount_paid >= amount` (a column
 * against a column), and "due day passed" is `due_date < todayStart`.
 */
function statusGroupWhere(
  group: AccountPayableStatusGroup,
  todayStart: Date,
  amountRef: AmountRef,
): Prisma.AccountPayableWhereInput {
  if (group === "PAID") return { amount_paid: { gte: amountRef } };

  const notFullyPaid: Prisma.AccountPayableWhereInput = {
    OR: [{ amount_paid: null }, { amount_paid: { lt: amountRef } }],
  };

  return {
    AND: [
      notFullyPaid,
      group === "OVERDUE"
        ? { due_date: { lt: todayStart } }
        : { due_date: { gte: todayStart } },
    ],
  };
}

/** Every group selected, or none, is no filter at all. */
function effectiveStatusGroups(
  groups: AccountPayableStatusGroup[] | undefined,
): AccountPayableStatusGroup[] | undefined {
  const selected = Array.from(new Set(groups ?? []));

  return selected.length === 0 ||
    selected.length === ACCOUNT_PAYABLE_STATUS_GROUPS.length
    ? undefined
    : selected;
}

/** A search term that reads as money matches the amounts exactly. */
function amountOf(term: string): number | null {
  const normalized = term.replace(/\s/g, "").replace(",", ".");

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;

  const value = Number(normalized);

  return Number.isFinite(value) ? value : null;
}

/**
 * The list's `where`. `withStatus: false` is the base the cards are counted
 * over (the disjunctive rule: every filter but the status one); `onlyGroup`
 * narrows that base to one situation.
 */
function accountPayableListWhere(
  filters: AccountPayableListFilters,
  context: {
    todayStart: Date;
    amountRef: AmountRef;
    withStatus: boolean;
    onlyGroup?: AccountPayableStatusGroup;
  },
): Prisma.AccountPayableWhereInput {
  const and: Prisma.AccountPayableWhereInput[] = [];

  if (filters.categories?.length) {
    and.push({ category: { in: filters.categories } });
  }

  const groups = context.withStatus
    ? effectiveStatusGroups(filters.statusGroups)
    : undefined;

  if (groups) {
    and.push({
      OR: groups.map((group) =>
        statusGroupWhere(group, context.todayStart, context.amountRef),
      ),
    });
  }

  if (context.onlyGroup) {
    and.push(
      statusGroupWhere(context.onlyGroup, context.todayStart, context.amountRef),
    );
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    const amount = amountOf(term);

    and.push(
      buildSearchOr<Prisma.AccountPayableWhereInput>([
        // Every id the row menu copies has to come back when pasted.
        { id: { contains: term, mode: "insensitive" } },
        { serviceOrderId: { contains: term, mode: "insensitive" } },
        { description: { contains: term, mode: "insensitive" } },
        { document_number: { contains: term, mode: "insensitive" } },
        { payee_name: { contains: term, mode: "insensitive" } },
        { supplier: { name: { contains: term, mode: "insensitive" } } },
        { vehicle: { license_plate: { contains: term, mode: "insensitive" } } },
        { registrationUser: { name: { contains: term, mode: "insensitive" } } },
        {
          branch: {
            OR: [
              { corporate_reason: { contains: term, mode: "insensitive" } },
              { fantasy_name: { contains: term, mode: "insensitive" } },
            ],
          },
        },
        ...(amount !== null
          ? [{ amount: amount }, { amount_paid: amount }]
          : []),
      ]),
    );
  }

  // The tenant stays a top-level key: the (businessId, created_at) index
  // serves every read of the list.
  return { businessId: filters.businessId, ...(and.length > 0 && { AND: and }) };
}

/** One situation's rows and money, over the card base. */
interface StatusGroupTotals {
  count: number;
  /** Σ amount of the group's bills. */
  amount: number;
  /** Σ amount_paid of the group's bills. */
  amountPaid: number;
}

type StatusGroupCounts = Record<AccountPayableStatusGroup, StatusGroupTotals>;

interface AccountPayableListSearchMeta {
  /** Cards: every filter except the status one, so the three add up. */
  total: number;
  open: number;
  overdue: number;
  paid: number;
  /** Still to pay on the open bills (Σ amount − Σ amount_paid). */
  openAmount: number;
  /** Still to pay on the overdue bills. */
  overdueAmount: number;
  /** Paid on the paid bills. */
  paidAmount: number;
  facets: { status: FacetCount[] };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The pager total, the cards and the status options, from the three group
 * totals. Exact because the three situations partition the bills: the rows
 * matching the status filter are the rows of the groups it keeps.
 */
function summarizeAccountPayableList(
  groups: StatusGroupCounts,
  filters: Pick<AccountPayableListFilters, "statusGroups">,
): { total: number; searchMeta: AccountPayableListSearchMeta } {
  const selected = effectiveStatusGroups(filters.statusGroups);

  const total = ACCOUNT_PAYABLE_STATUS_GROUPS.filter(
    (group) => !selected || selected.includes(group),
  ).reduce((sum, group) => sum + groups[group].count, 0);

  const remaining = (group: AccountPayableStatusGroup) =>
    round2(Math.max(0, groups[group].amount - groups[group].amountPaid));

  return {
    total,
    searchMeta: {
      total: groups.OPEN.count + groups.OVERDUE.count + groups.PAID.count,
      open: groups.OPEN.count,
      overdue: groups.OVERDUE.count,
      paid: groups.PAID.count,
      openAmount: remaining("OPEN"),
      overdueAmount: remaining("OVERDUE"),
      paidAmount: round2(groups.PAID.amountPaid),
      facets: {
        status: ACCOUNT_PAYABLE_STATUS_GROUPS.map((group) => ({
          value: group,
          count: groups[group].count,
        })),
      },
    },
  };
}

export {
  ACCOUNT_PAYABLE_CATEGORIES,
  ACCOUNT_PAYABLE_SORT,
  ACCOUNT_PAYABLE_SORT_FALLBACK,
  ACCOUNT_PAYABLE_SORT_KEYS,
  accountPayableListWhere,
  amountOf,
  effectiveStatusGroups,
  statusGroupWhere,
  summarizeAccountPayableList,
  type AccountPayableListFilters,
  type AccountPayableListSearchMeta,
  type AccountPayableSortKey,
  type AmountRef,
  type StatusGroupCounts,
  type StatusGroupTotals,
};
