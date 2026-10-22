import type { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

/**
 * The driver list's server-side table (decision 8.8): what it sorts by, what
 * it filters by, and how the cards and filter counts are derived. The web
 * table and the export read the same definitions, so the file a manager
 * downloads is the list on screen.
 */

const DRIVER_STATUSES = ["ACTIVE", "INACTIVE"] as const;
const DRIVER_CONTRACT_TYPES = ["OWNED", "THIRD_PARTY"] as const;

/** CTB art. 143 classes, the combined ones included (schema enum CnhCategory). */
const CNH_CATEGORIES = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "AB",
  "AC",
  "AD",
  "AE",
] as const;

/**
 * The category facet also offers "no category": legacy drivers predate the
 * column, and finding them is exactly why someone opens that filter.
 */
const CNH_CATEGORY_NONE = "NONE";
const CNH_CATEGORY_FACET_VALUES = [
  ...CNH_CATEGORIES,
  CNH_CATEGORY_NONE,
] as const;

type DriverStatus = (typeof DRIVER_STATUSES)[number];
type DriverContractType = (typeof DRIVER_CONTRACT_TYPES)[number];
type CnhCategory = (typeof CNH_CATEGORIES)[number];
type CnhCategoryFacet = (typeof CNH_CATEGORY_FACET_VALUES)[number];

/** Same ids as the web table's columns, so the URL value is the column id. */
const DRIVER_SORT_KEYS = [
  "created_at",
  "updated_at",
  "name",
  "status",
  "contract_type",
  "birth_date",
  "cnh_category",
  "cnh_expires_at",
  "city",
  "uf",
] as const;

type DriverSortKey = (typeof DRIVER_SORT_KEYS)[number];

const DRIVER_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

type OrderBy = Prisma.DriverOrderByWithRelationInput;

/**
 * Nullable columns keep their blanks at the end in both directions: a list
 * sorted by CNH expiry must open on real dates, not on the legacy rows that
 * have none (Postgres would put NULLs first in DESC).
 */
const nullsLast =
  (column: "cnh_category" | "cnh_expires_at") =>
  (order: SortOrder): OrderBy => ({
    [column]: { sort: order, nulls: "last" },
  });

const DRIVER_SORT: SortSpec<DriverSortKey, OrderBy> = {
  keys: DRIVER_SORT_KEYS,
  fallback: DRIVER_SORT_FALLBACK,
  columns: {
    created_at: (order) => ({ created_at: order }),
    updated_at: (order) => ({ updated_at: order }),
    name: (order) => ({ name: order }),
    status: (order) => ({ status: order }),
    contract_type: (order) => ({ contract_type: order }),
    birth_date: (order) => ({ birth_date: order }),
    cnh_category: nullsLast("cnh_category"),
    cnh_expires_at: nullsLast("cnh_expires_at"),
    city: (order) => ({ city: order }),
    uf: (order) => ({ uf: order }),
  },
  // Newest first inside a tie; the id breaks what created_at cannot.
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface DriverListFilters {
  businessId: string;
  search?: string;
  statuses?: DriverStatus[];
  contractTypes?: DriverContractType[];
  cnhCategories?: CnhCategoryFacet[];
  branchIds?: string[];
}

type DriverFacet = "status" | "contract_type" | "cnh_category" | "branchId";

/**
 * The fields a typed term is compared with, as one escaped OR (buildSearchOr
 * makes `%` and `_` literal). Digits-only documents (CPF, CEP, RG) are
 * compared with the digits of the term, so "123.456" finds a CPF stored as
 * "12345678901". Null without a term.
 */
function driverSearchWhere(
  search: string | undefined,
): Prisma.DriverWhereInput | null {
  const term = search?.trim() ?? "";

  if (!term) return null;

  const digits = term.replace(/\D/g, "");

  return buildSearchOr<Prisma.DriverWhereInput>([
    { id: { contains: term, mode: "insensitive" as const } },
    { name: { contains: term, mode: "insensitive" as const } },
    { cnh: { contains: term, mode: "insensitive" as const } },
    { city: { contains: term, mode: "insensitive" as const } },
    { uf: { contains: term, mode: "insensitive" as const } },
    { street: { contains: term, mode: "insensitive" as const } },
    { address_number: { contains: term, mode: "insensitive" as const } },
    { branchId: { contains: term, mode: "insensitive" as const } },
    ...(digits
      ? [
          { cpf: { contains: digits, mode: "insensitive" as const } },
          { cep: { contains: digits, mode: "insensitive" as const } },
          { rg: { contains: digits, mode: "insensitive" as const } },
        ]
      : []),
  ]);
}

function cnhCategoryWhere(values: CnhCategoryFacet[]): Prisma.DriverWhereInput {
  const categories = values.filter(
    (value): value is CnhCategory => value !== CNH_CATEGORY_NONE,
  );
  const withNone = values.includes(CNH_CATEGORY_NONE);

  const or: Prisma.DriverWhereInput[] = [
    ...(categories.length > 0 ? [{ cnh_category: { in: categories } }] : []),
    ...(withNone ? [{ cnh_category: null }] : []),
  ];

  return or.length === 1 ? or[0] : { OR: or };
}

/**
 * The list's `where`. `withFacets: false` is the base the counts are grouped
 * over: every facet is a column of the driver row, so one GROUP BY over the
 * base yields the pager total, the cards and each filter's options exactly
 * (see summarizeDriverList) without a scan per facet.
 */
function driverListWhere(
  filters: DriverListFilters,
  { withFacets }: { withFacets: boolean },
): Prisma.DriverWhereInput {
  const and: Prisma.DriverWhereInput[] = [];

  if (withFacets) {
    if (filters.statuses?.length) {
      and.push({ status: { in: filters.statuses } });
    }

    if (filters.contractTypes?.length) {
      and.push({ contract_type: { in: filters.contractTypes } });
    }

    if (filters.cnhCategories?.length) {
      and.push(cnhCategoryWhere(filters.cnhCategories));
    }

    if (filters.branchIds?.length) {
      and.push({ branchId: { in: filters.branchIds } });
    }
  }

  const search = driverSearchWhere(filters.search);

  if (search) and.push(search);

  // The tenant stays a top-level key: the (businessId, created_at) index
  // serves every read of the list, and no facet can widen past it.
  return {
    businessId: filters.businessId,
    ...(and.length > 0 && { AND: and }),
  };
}

/** Drivers per combination of the four faceted columns, over the base. */
interface DriverGroupCount {
  status: DriverStatus;
  contract_type: DriverContractType;
  cnh_category: CnhCategory | null;
  branchId: string | null;
  count: number;
}

interface DriverListSearchMeta {
  /** Cards: every filter but status, so Ativos + Inativos = Total. */
  total: number;
  active: number;
  inactive: number;
  /** Every filter but contract type, so Próprios + Terceirizados add up. */
  owned: number;
  thirdParty: number;
  facets: {
    status: FacetCount[];
    contract_type: FacetCount[];
    cnh_category: FacetCount[];
    branchId: FacetCount[];
  };
}

function valueOf(group: DriverGroupCount, facet: DriverFacet): string | null {
  if (facet === "cnh_category") return group.cnh_category ?? CNH_CATEGORY_NONE;

  return group[facet];
}

function selectedOf(
  filters: Pick<
    DriverListFilters,
    "statuses" | "contractTypes" | "cnhCategories" | "branchIds"
  >,
  facet: DriverFacet,
): readonly string[] | undefined {
  const selected = {
    status: filters.statuses,
    contract_type: filters.contractTypes,
    cnh_category: filters.cnhCategories,
    branchId: filters.branchIds,
  }[facet];

  return selected && selected.length > 0 ? selected : undefined;
}

const FACETS: readonly DriverFacet[] = [
  "status",
  "contract_type",
  "cnh_category",
  "branchId",
];

/**
 * The pager total, the cards and every filter's options, from the grouped
 * counts. Disjunctive: a number broken down by a facet is counted with every
 * OTHER filter applied, never its own, so picking "Inativo" narrows the table
 * without zeroing the "Ativos" card, and each option still says how many it
 * would bring. Exact, because every facet is a column of the grouped row.
 */
function summarizeDriverList(
  groups: DriverGroupCount[],
  filters: Pick<
    DriverListFilters,
    "statuses" | "contractTypes" | "cnhCategories" | "branchIds"
  >,
  branchNames: ReadonlyMap<string, string> = new Map(),
): { total: number; searchMeta: DriverListSearchMeta } {
  const keeps = (group: DriverGroupCount, except?: DriverFacet) =>
    FACETS.every((facet) => {
      if (facet === except) return true;

      const selected = selectedOf(filters, facet);
      const value = valueOf(group, facet);

      return !selected || (value !== null && selected.includes(value));
    });

  const countBy = (facet: DriverFacet): Map<string, number> => {
    const counts = new Map<string, number>();

    for (const group of groups) {
      const value = valueOf(group, facet);

      if (value === null || !keeps(group, facet)) continue;

      counts.set(value, (counts.get(value) ?? 0) + group.count);
    }

    return counts;
  };

  const closedSet = (facet: DriverFacet, values: readonly string[]) => {
    const counts = countBy(facet);

    return values.map((value) => ({ value, count: counts.get(value) ?? 0 }));
  };

  const statusCounts = countBy("status");
  const contractCounts = countBy("contract_type");

  // Every branch the base has, plus a selected one that zeroed, so its chip
  // keeps a name. Only names of this company's branches ever reach here.
  const branchCounts = countBy("branchId");
  const baseBranches = new Set(
    groups.flatMap((group) => (group.branchId ? [group.branchId] : [])),
  );
  const branchOptions: FacetCount[] = [
    ...new Set([...baseBranches, ...(filters.branchIds ?? [])]),
  ]
    .filter((id) => branchNames.has(id))
    .map((id) => ({
      value: id,
      label: branchNames.get(id),
      count: branchCounts.get(id) ?? 0,
    }))
    .sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "", "pt-BR"));

  const active = statusCounts.get("ACTIVE") ?? 0;
  const inactive = statusCounts.get("INACTIVE") ?? 0;

  return {
    total: groups
      .filter((group) => keeps(group))
      .reduce((sum, group) => sum + group.count, 0),
    searchMeta: {
      total: active + inactive,
      active,
      inactive,
      owned: contractCounts.get("OWNED") ?? 0,
      thirdParty: contractCounts.get("THIRD_PARTY") ?? 0,
      facets: {
        status: closedSet("status", DRIVER_STATUSES),
        contract_type: closedSet("contract_type", DRIVER_CONTRACT_TYPES),
        cnh_category: closedSet("cnh_category", CNH_CATEGORY_FACET_VALUES),
        branchId: branchOptions,
      },
    },
  };
}

export {
  CNH_CATEGORIES,
  CNH_CATEGORY_FACET_VALUES,
  CNH_CATEGORY_NONE,
  DRIVER_CONTRACT_TYPES,
  DRIVER_SORT,
  DRIVER_SORT_FALLBACK,
  DRIVER_SORT_KEYS,
  DRIVER_STATUSES,
  driverListWhere,
  driverSearchWhere,
  summarizeDriverList,
  type CnhCategory,
  type CnhCategoryFacet,
  type DriverContractType,
  type DriverGroupCount,
  type DriverListFilters,
  type DriverListSearchMeta,
  type DriverSortKey,
  type DriverStatus,
};
