import type { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";
import {
  summarizeCatalogUsage,
  type CatalogLeader,
  type CatalogUsage,
} from "@/shared/pagination/catalog-usage";

/**
 * The fuel types list on the server-side table contract (decision 8.8). A
 * company has at most one row per fuel (eight kinds), so there is no facet:
 * the search covers it. What the server owes is the order and the cards,
 * over the whole search.
 */

/** Same ids as the web table's columns. */
const FUEL_TYPE_SORT_KEYS = [
  "created_at",
  "description",
  "updated_at",
] as const;

type FuelTypeSortKey = (typeof FUEL_TYPE_SORT_KEYS)[number];

const FUEL_TYPE_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

const FUEL_TYPE_SORT: SortSpec<
  FuelTypeSortKey,
  Prisma.FuelTypeOrderByWithRelationInput
> = {
  keys: FUEL_TYPE_SORT_KEYS,
  fallback: FUEL_TYPE_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    description: (order: SortOrder) => ({ description: order }),
    updated_at: (order: SortOrder) => ({ updated_at: order }),
  },
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface FuelTypeListFilters {
  businessId: string;
  search?: string;
}

function fuelTypeListWhere(
  filters: FuelTypeListFilters,
): Prisma.FuelTypeWhereInput {
  const term = filters.search?.trim() ?? "";

  // Tenant first and alone at the top: no OR widens past it.
  return {
    businessId: filters.businessId,
    ...(term && {
      AND: [
        buildSearchOr<Prisma.FuelTypeWhereInput>([
          { id: { contains: term, mode: "insensitive" } },
          { description: { contains: term, mode: "insensitive" } },
        ]),
      ],
    }),
  };
}

/** The refuelings of one fuel type in the business month (the repository's groupBy). */
interface FuelTypeRefuelingUsage {
  fuelTypeId: string;
  refuelings: number;
  liters: number;
  amount: number;
}

/** The fuel most liters went to this month, with what a liter cost on average. */
interface FuelTypeMonthLeader {
  id: string;
  label: string;
  refuelings: number;
  liters: number;
  /** Total paid / liters (weighted), not the mean of the receipts' prices. */
  averagePricePerLiter: number;
}

interface FuelTypeMonthStats {
  /** "YYYY-MM" of the company's business month the numbers cover. */
  month: string;
  refuelings: number;
  liters: number;
  amount: number;
  mostRefueled: FuelTypeMonthLeader | null;
}

/** The cards (`meta.searchMeta`), over every fuel type the search finds. */
interface FuelTypeListSearchMeta {
  /** Fuel types of the search: the pager's total. */
  total: number;
  /** Vehicles registered with one of them. */
  vehicles: number;
  /** Fuel types no vehicle uses. */
  withoutVehicles: number;
  /** The fuel most vehicles run on; null while no vehicle has one of them. */
  mostUsed: CatalogLeader | null;
  /**
   * This month's refuelings of those types. Null when the caller cannot see
   * refuelings: the company did not hire Gestão de Frotas, or the profile
   * does not read Abastecimentos. The catalog is open to both; the
   * refuelings are not.
   */
  month: FuelTypeMonthStats | null;
}

const round = (value: number, places: number): number => {
  const factor = 10 ** places;

  return Math.round(value * factor) / factor;
};

const collator = new Intl.Collator("pt-BR", { sensitivity: "base" });

function summarizeMonth(
  usage: ReadonlyArray<CatalogUsage>,
  refuelings: ReadonlyArray<FuelTypeRefuelingUsage>,
  month: string,
): FuelTypeMonthStats {
  const labels = new Map(usage.map((entry) => [entry.id, entry.label]));

  // Only types of the search: the repository already filters by them; this
  // keeps a stray row from naming a type the table does not show.
  const rows = refuelings.filter(
    (row) => labels.has(row.fuelTypeId) && row.refuelings > 0,
  );

  const leader = [...rows].sort(
    (a, b) =>
      b.liters - a.liters ||
      collator.compare(
        labels.get(a.fuelTypeId) ?? "",
        labels.get(b.fuelTypeId) ?? "",
      ) ||
      (a.fuelTypeId < b.fuelTypeId ? -1 : 1),
  )[0];

  return {
    month,
    refuelings: rows.reduce((sum, row) => sum + row.refuelings, 0),
    liters: round(
      rows.reduce((sum, row) => sum + row.liters, 0),
      3,
    ),
    amount: round(
      rows.reduce((sum, row) => sum + row.amount, 0),
      2,
    ),
    mostRefueled: leader
      ? {
          id: leader.fuelTypeId,
          label: labels.get(leader.fuelTypeId) ?? "",
          refuelings: leader.refuelings,
          liters: round(leader.liters, 3),
          averagePricePerLiter:
            leader.liters > 0 ? round(leader.amount / leader.liters, 3) : 0,
        }
      : null,
  };
}

/**
 * Folds the vehicle count of each type of the search and, when the caller
 * may see them, this month's refuelings per type.
 */
function summarizeFuelTypeList(
  usage: ReadonlyArray<CatalogUsage>,
  refuelings: {
    month: string;
    rows: ReadonlyArray<FuelTypeRefuelingUsage>;
  } | null,
): FuelTypeListSearchMeta {
  const { total, linked, unused, leader } = summarizeCatalogUsage(usage);

  return {
    total,
    vehicles: linked,
    withoutVehicles: unused,
    mostUsed: leader,
    month: refuelings
      ? summarizeMonth(usage, refuelings.rows, refuelings.month)
      : null,
  };
}

export {
  summarizeFuelTypeList,
  type FuelTypeListSearchMeta,
  type FuelTypeMonthStats,
  type FuelTypeRefuelingUsage,
  FUEL_TYPE_SORT,
  FUEL_TYPE_SORT_FALLBACK,
  FUEL_TYPE_SORT_KEYS,
  fuelTypeListWhere,
  type FuelTypeListFilters,
  type FuelTypeSortKey,
};
