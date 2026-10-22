import type { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

/**
 * The service order listing's server-side table (decision 8.8): what it
 * sorts by, what it filters by, and how the cards and filter counts are
 * derived. The cards used to be computed by the web over the ten rows of the
 * loaded page ("Ordens Concluídas: 3 (2%)" of a fleet with 150 orders).
 */

/** Open = no completion date yet; the one status the order has. */
const SERVICE_ORDER_STATUSES = ["open", "completed"] as const;

type ServiceOrderStatus = (typeof SERVICE_ORDER_STATUSES)[number];

/** Where the work is done, not its nature (FLEET-SO-3). */
const MAINTENANCE_TYPES = ["INTERNAL", "EXTERNAL"] as const;

type MaintenanceTypeValue = (typeof MAINTENANCE_TYPES)[number];

/** Same ids as the web table's columns: the URL `sort` value is the column id. */
const SERVICE_ORDER_SORT_KEYS = [
  "created_at",
  "updated_at",
  "date",
  "completion_date",
  "total_amount",
  "maintenance_type",
  "vehicleLicensePlate",
  "responsibleUserName",
  "supplierName",
  "branchName",
] as const;

type ServiceOrderSortKey = (typeof SERVICE_ORDER_SORT_KEYS)[number];

const SERVICE_ORDER_SORT_FALLBACK = {
  sort: "created_at",
  order: "desc",
} as const;

type OrderBy = Prisma.ServiceOrderOrderByWithRelationInput;

const SERVICE_ORDER_SORT: SortSpec<ServiceOrderSortKey, OrderBy> = {
  keys: SERVICE_ORDER_SORT_KEYS,
  fallback: SERVICE_ORDER_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    updated_at: (order: SortOrder) => ({ updated_at: order }),
    date: (order: SortOrder) => ({ date: order }),
    completion_date: (order: SortOrder) => ({ completion_date: order }),
    total_amount: (order: SortOrder) => ({ total_amount: order }),
    maintenance_type: (order: SortOrder) => ({ maintenance_type: order }),
    vehicleLicensePlate: (order: SortOrder) => ({
      vehicle: { license_plate: order },
    }),
    responsibleUserName: (order: SortOrder) => ({
      responsibleUser: { name: order },
    }),
    supplierName: (order: SortOrder) => ({ supplier: { name: order } }),
    branchName: (order: SortOrder) => ({ branch: { corporate_reason: order } }),
  },
  // Newest first inside a tie; the id breaks what created_at cannot.
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface ServiceOrderListFilters {
  businessId: string;
  search?: string;
  statuses?: ServiceOrderStatus[];
  maintenanceTypes?: MaintenanceTypeValue[];
  branchIds?: string[];
}

type FacetName = "status" | "maintenanceType" | "branch";

/**
 * Both statuses selected is no filter, and neither is one either. Returns the
 * condition on completion_date, or undefined.
 */
function statusCondition(
  statuses: ServiceOrderStatus[] | undefined,
): Prisma.ServiceOrderWhereInput | undefined {
  const selected = new Set(statuses ?? []);

  if (selected.size !== 1) return undefined;

  return selected.has("open")
    ? { completion_date: null }
    : { completion_date: { not: null } };
}

/**
 * The listing's `where`. `except` leaves facets out: the counts of a facet
 * are taken with every OTHER filter applied (the disjunctive rule of
 * shared/pagination/list-meta), so its options keep their numbers when one is
 * picked.
 */
function serviceOrderListWhere(
  filters: ServiceOrderListFilters,
  { except = [] }: { except?: FacetName[] } = {},
): Prisma.ServiceOrderWhereInput {
  const and: Prisma.ServiceOrderWhereInput[] = [];

  if (!except.includes("status")) {
    const status = statusCondition(filters.statuses);

    if (status) and.push(status);
  }

  if (!except.includes("maintenanceType") && filters.maintenanceTypes?.length) {
    and.push({ maintenance_type: { in: filters.maintenanceTypes } });
  }

  if (!except.includes("branch") && filters.branchIds?.length) {
    and.push({ branchId: { in: filters.branchIds } });
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    const numeric = Number(term.replace(",", "."));

    and.push(
      buildSearchOr<Prisma.ServiceOrderWhereInput>([
        // The ids are copiable from the row menu, so they come back when pasted.
        { id: { contains: term, mode: "insensitive" } },
        { description: { contains: term, mode: "insensitive" } },
        {
          vehicle: {
            OR: [
              { license_plate: { contains: term, mode: "insensitive" } },
              { description: { contains: term, mode: "insensitive" } },
            ],
          },
        },
        { responsibleUser: { name: { contains: term, mode: "insensitive" } } },
        {
          branch: {
            OR: [
              { corporate_reason: { contains: term, mode: "insensitive" } },
              { fantasy_name: { contains: term, mode: "insensitive" } },
            ],
          },
        },
        { supplier: { name: { contains: term, mode: "insensitive" } } },
        ...(Number.isFinite(numeric) && /\d/.test(term)
          ? [{ total_amount: numeric }]
          : []),
      ]),
    );
  }

  // The tenant stays a top-level key: the (businessId, created_at) index
  // serves every read of the list, and isolation never depends on the OR.
  return {
    businessId: filters.businessId,
    ...(and.length > 0 && { AND: and }),
  };
}

/** Orders and money per status × maintenance type, over search + branch facet. */
interface ServiceOrderTypeCount {
  status: ServiceOrderStatus;
  maintenance_type: MaintenanceTypeValue;
  count: number;
  totalAmount: number;
}

interface ServiceOrderListSearchMeta {
  /** Cards: every filter except status, so open + completed = total. */
  total: number;
  open: number;
  completed: number;
  /** Money of the rows the table shows (every filter applied). */
  totalAmount: number;
  facets: {
    status: FacetCount[];
    maintenanceType: FacetCount[];
    branchId: FacetCount[];
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The pager total, the cards and the filter options from the status × type
 * counts (taken over search + branch facet) and the branch counts (taken
 * over search + status + type). Exact because status and type partition the
 * rows: the rows matching every facet are the cells both facets keep.
 */
function summarizeServiceOrderList(
  cells: ServiceOrderTypeCount[],
  branchCounts: FacetCount[],
  filters: Pick<
    ServiceOrderListFilters,
    "statuses" | "maintenanceTypes" | "branchIds"
  >,
): { total: number; searchMeta: ServiceOrderListSearchMeta } {
  const statusSet = new Set(filters.statuses ?? []);
  const typeSet = new Set(filters.maintenanceTypes ?? []);

  // One status selected filters; none or both do not (statusCondition).
  const keptByStatus = (cell: ServiceOrderTypeCount) =>
    statusSet.size !== 1 || statusSet.has(cell.status);

  const keptByType = (cell: ServiceOrderTypeCount) =>
    typeSet.size === 0 || typeSet.has(cell.maintenance_type);

  const sum = (entries: ServiceOrderTypeCount[]) =>
    entries.reduce((total, cell) => total + cell.count, 0);

  const cardCells = cells.filter(keptByType);
  const rowCells = cardCells.filter(keptByStatus);

  const open = sum(cardCells.filter((cell) => cell.status === "open"));
  const completed = sum(
    cardCells.filter((cell) => cell.status === "completed"),
  );

  const statusOptions: FacetCount[] = SERVICE_ORDER_STATUSES.map((status) => ({
    value: status,
    count: sum(cardCells.filter((cell) => cell.status === status)),
  }));

  const typeCells = cells.filter(keptByStatus);

  const typeOptions: FacetCount[] = MAINTENANCE_TYPES.map((type) => ({
    value: type,
    count: sum(typeCells.filter((cell) => cell.maintenance_type === type)),
  }));

  return {
    total: sum(rowCells),
    searchMeta: {
      total: open + completed,
      open,
      completed,
      totalAmount: round2(
        rowCells.reduce((total, cell) => total + cell.totalAmount, 0),
      ),
      facets: {
        status: statusOptions,
        maintenanceType: typeOptions,
        branchId: branchCounts,
      },
    },
  };
}

/**
 * Σ unit price × quantity − discount of an order's parts, the figure the
 * typed total_amount is compared with (FLEET-SO-2: the total stays typed —
 * it is labour + parts as the workshop billed it — and the screen warns when
 * the parts alone already exceed it).
 */
function partsTotalOf(
  parts: ReadonlyArray<{
    unit_price: unknown;
    quantity: number;
    discount_percentage?: unknown;
  }>,
): number {
  return round2(
    parts.reduce((total, part) => {
      const gross = Number(part.unit_price) * part.quantity;
      const discount = Number(part.discount_percentage ?? 0) || 0;

      return total + gross * (1 - discount / 100);
    }, 0),
  );
}

export {
  MAINTENANCE_TYPES,
  SERVICE_ORDER_SORT,
  SERVICE_ORDER_SORT_FALLBACK,
  SERVICE_ORDER_SORT_KEYS,
  SERVICE_ORDER_STATUSES,
  partsTotalOf,
  serviceOrderListWhere,
  statusCondition,
  summarizeServiceOrderList,
  type MaintenanceTypeValue,
  type ServiceOrderListFilters,
  type ServiceOrderListSearchMeta,
  type ServiceOrderSortKey,
  type ServiceOrderStatus,
  type ServiceOrderTypeCount,
};
