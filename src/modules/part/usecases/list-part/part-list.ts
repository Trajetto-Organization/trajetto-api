import type { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

/**
 * The parts catalog's server-side table (decision 8.8). Its cards used to add
 * up the ten rows on screen and call the sum of their unit prices an
 * "estimativa de estoque" — the catalog keeps no stock at all.
 */

/** Same ids as the web table's columns. */
const PART_SORT_KEYS = [
  "created_at",
  "updated_at",
  "description",
  "unit_price",
  "supplierName",
] as const;

type PartSortKey = (typeof PART_SORT_KEYS)[number];

const PART_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

const PART_SORT: SortSpec<PartSortKey, Prisma.PartOrderByWithRelationInput> = {
  keys: PART_SORT_KEYS,
  fallback: PART_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    updated_at: (order: SortOrder) => ({ updated_at: order }),
    description: (order: SortOrder) => ({ description: order }),
    unit_price: (order: SortOrder) => ({ unit_price: order }),
    supplierName: (order: SortOrder) => ({ supplier: { name: order } }),
  },
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface PartListFilters {
  businessId: string;
  search?: string;
  supplierIds?: string[];
}

function partListWhere(
  filters: PartListFilters,
  { except }: { except?: "supplier" } = {},
): Prisma.PartWhereInput {
  const and: Prisma.PartWhereInput[] = [];

  if (except !== "supplier" && filters.supplierIds?.length) {
    and.push({ supplierId: { in: filters.supplierIds } });
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    and.push(
      buildSearchOr<Prisma.PartWhereInput>([
        { id: { contains: term, mode: "insensitive" } },
        { description: { contains: term, mode: "insensitive" } },
        { supplier: { name: { contains: term, mode: "insensitive" } } },
      ]),
    );
  }

  return {
    businessId: filters.businessId,
    ...(and.length > 0 && { AND: and }),
  };
}

/** Parts and the sum of their prices per supplier (null = no supplier). */
interface PartSupplierCount {
  supplierId: string | null;
  label?: string;
  count: number;
  priceSum: number;
}

interface PartListSearchMeta {
  /** Cards: every filter except supplier, so with + without = total. */
  total: number;
  withSupplier: number;
  withoutSupplier: number;
  /** Mean unit price of the same set, rounded to cents. */
  averagePrice: number;
  facets: { supplierId: FacetCount[] };
}

function summarizePartList(
  groups: PartSupplierCount[],
  filters: Pick<PartListFilters, "supplierIds">,
): { total: number; searchMeta: PartListSearchMeta } {
  const selected = filters.supplierIds?.length
    ? new Set(filters.supplierIds)
    : undefined;

  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const priceSum = groups.reduce((sum, group) => sum + group.priceSum, 0);

  const withSupplier = groups
    .filter((group) => group.supplierId !== null)
    .reduce((sum, group) => sum + group.count, 0);

  const rows = selected
    ? groups
        .filter((group) => group.supplierId && selected.has(group.supplierId))
        .reduce((sum, group) => sum + group.count, 0)
    : total;

  const options: FacetCount[] = groups
    .filter((group): group is PartSupplierCount & { supplierId: string } =>
      Boolean(group.supplierId && group.label !== undefined),
    )
    .map((group) => ({
      value: group.supplierId,
      label: group.label,
      count: group.count,
    }))
    .sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "", "pt-BR"));

  return {
    total: rows,
    searchMeta: {
      total,
      withSupplier,
      withoutSupplier: total - withSupplier,
      averagePrice: total > 0 ? Math.round((priceSum / total) * 100) / 100 : 0,
      facets: { supplierId: options },
    },
  };
}

/**
 * The key two descriptions are the same part by: case and edge spaces do not
 * make a second "Filtro de óleo". The same expression as the unique index
 * planned in FLEET-DUP-1 (lower(btrim(description))), so the message comes
 * before the constraint.
 */
function partDescriptionKey(description: string): string {
  return description.trim().toLowerCase();
}

export {
  PART_SORT,
  PART_SORT_FALLBACK,
  PART_SORT_KEYS,
  partDescriptionKey,
  partListWhere,
  summarizePartList,
  type PartListFilters,
  type PartListSearchMeta,
  type PartSortKey,
  type PartSupplierCount,
};
