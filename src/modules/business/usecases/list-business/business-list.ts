import type { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { sumCounts, type FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

/**
 * The companies list's server-side table (decision 8.8): its order, its
 * filters and its cards over every company, never over the ten rows a page
 * holds. The old screen counted "Com código ERP", "Por Estado" and "Por
 * Cidade" on the loaded page and filtered name, e-mail, city and CNPJ among
 * those ten rows.
 */

const BRAZILIAN_UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT",
  "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP",
  "TO",
] as const;

type BusinessUf = (typeof BRAZILIAN_UFS)[number];

/** The status facet: `is_active` as the words the URL carries. */
const BUSINESS_STATUSES = ["active", "inactive"] as const;

type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

/** Same ids as the web table's columns, so the URL value is the column id. */
const BUSINESS_SORT_KEYS = [
  "created_at",
  "updated_at",
  "corporate_reason",
  "fantasy_name",
  "cnpj",
  "city",
  "uf",
  "erp_code",
  "responsible_name",
  "email",
  "is_active",
] as const;

type BusinessSortKey = (typeof BUSINESS_SORT_KEYS)[number];

const BUSINESS_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

const BUSINESS_SORT: SortSpec<BusinessSortKey, Prisma.BusinessOrderByWithRelationInput> = {
  keys: BUSINESS_SORT_KEYS,
  fallback: BUSINESS_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    updated_at: (order: SortOrder) => ({ updated_at: order }),
    corporate_reason: (order: SortOrder) => ({ corporate_reason: order }),
    // Without a trade name or an ERP code, last either way.
    fantasy_name: (order: SortOrder) => ({ fantasy_name: { sort: order, nulls: "last" } }),
    cnpj: (order: SortOrder) => ({ cnpj: order }),
    city: (order: SortOrder) => ({ city: order }),
    uf: (order: SortOrder) => ({ uf: order }),
    erp_code: (order: SortOrder) => ({ erp_code: { sort: order, nulls: "last" } }),
    responsible_name: (order: SortOrder) => ({ responsible_name: order }),
    email: (order: SortOrder) => ({ email: order }),
    is_active: (order: SortOrder) => ({ is_active: order }),
  },
  // Newest first inside a tie; the id breaks what created_at cannot.
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

/** How many states and cities the "Por Estado" / "Por Cidade" cards name. */
const TOP_PLACES = 3;

interface BusinessListFilters {
  search?: string;
  statuses?: BusinessStatus[];
  ufs?: BusinessUf[];
  /**
   * Set for a reader who is not the MASTER: that reader's own company only.
   * The route admits the MASTER alone today; the repository keeps the wall
   * anyway, so a route opened later cannot list every company.
   */
  ownBusinessId?: string;
}

/** Digits of a term, for the columns stored as digits (CNPJ, CEP, phone). */
function digitsOf(term: string): { digits: string; phoneDigits: string } {
  const digits = term.replace(/\D/g, "");
  const phoneDigits = digits.startsWith("55") && digits.length > 10 ? digits.slice(2) : digits;

  return { digits, phoneDigits };
}

/**
 * The list's `where`. `except` drops one facet (or both), for the breakdown
 * that facet is counted over (the disjunctive rule).
 */
function businessListWhere(
  filters: BusinessListFilters,
  { except }: { except?: "status" | "uf" | "facets" } = {},
): Prisma.BusinessWhereInput {
  const and: Prisma.BusinessWhereInput[] = [];

  const keepStatus = except !== "status" && except !== "facets";
  const keepUf = except !== "uf" && except !== "facets";

  // Both statuses selected is no filter at all.
  if (keepStatus && filters.statuses?.length === 1) {
    and.push({ is_active: filters.statuses[0] === "active" });
  }

  if (keepUf && filters.ufs?.length) and.push({ uf: { in: filters.ufs } });

  const term = filters.search?.trim() ?? "";

  if (term) {
    const { digits, phoneDigits } = digitsOf(term);

    and.push(
      buildSearchOr<Prisma.BusinessWhereInput>([
        { id: { contains: term, mode: "insensitive" } },
        { corporate_reason: { contains: term, mode: "insensitive" } },
        { fantasy_name: { contains: term, mode: "insensitive" } },
        { city: { contains: term, mode: "insensitive" } },
        { uf: { contains: term, mode: "insensitive" } },
        { street: { contains: term, mode: "insensitive" } },
        { address_number: { contains: term, mode: "insensitive" } },
        { complement: { contains: term, mode: "insensitive" } },
        { cnae: { contains: term, mode: "insensitive" } },
        { erp_code: { contains: term, mode: "insensitive" } },
        { responsible_name: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        ...(digits
          ? [
              { cep: { contains: digits } },
              { telephone: { contains: phoneDigits } },
              { cnpj: { contains: digits } },
            ]
          : []),
      ]),
    );
  }

  return {
    ...(filters.ownBusinessId !== undefined && { id: filters.ownBusinessId }),
    ...(and.length > 0 && { AND: and }),
  };
}

/** Companies per (is_active, uf) over the base: search applied, facets not. */
interface BusinessGroupCount {
  is_active: boolean;
  uf: string;
  count: number;
  withErpCode: number;
}

/** One place of the "Por Estado" / "Por Cidade" cards. */
interface PlaceCount {
  value: string;
  count: number;
}

interface BusinessListSearchMeta {
  /** Cards: every filter applied, except for a card broken down by a facet. */
  total: number;
  withErpCode: number;
  /**
   * The states with most companies, most first (at most three), under every
   * filter but the UF one: picking a state narrows the table, not the card.
   */
  topStates: PlaceCount[];
  /** The cities ("Cidade/UF") with most companies, most first (at most three). */
  topCities: PlaceCount[];
  facets: { status: FacetCount[]; uf: FacetCount[] };
}

/** How a city reads on the card: "São José/SC" (two states share names). */
function cityLabel(city: string, uf: string): string {
  return `${city}/${uf}`;
}

/** Most first; the name breaks a tie, as the GROUP BY's ORDER BY does. */
function topPlaces(counts: Map<string, number>): PlaceCount[] {
  return Array.from(counts, ([value, count]) => ({ value, count }))
    .filter((place) => place.count > 0)
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, TOP_PLACES);
}

/**
 * The pager total, the cards and both facets' options from one GROUP BY
 * (is_active, uf) over the base, plus the top cities the repository counted
 * over the fully filtered set. Exact because both facets are functions of
 * the row's own columns.
 */
function summarizeBusinessList(
  groups: BusinessGroupCount[],
  topCities: PlaceCount[],
  filters: Pick<BusinessListFilters, "statuses" | "ufs">,
): { total: number; searchMeta: BusinessListSearchMeta } {
  const statusFilter = filters.statuses?.length === 1 ? filters.statuses[0] : undefined;
  const ufFilter = filters.ufs?.length ? new Set<string>(filters.ufs) : null;

  const matchesStatus = (group: BusinessGroupCount) =>
    !statusFilter || group.is_active === (statusFilter === "active");
  const matchesUf = (group: BusinessGroupCount) => !ufFilter || ufFilter.has(group.uf);

  const kept = groups.filter((group) => matchesStatus(group) && matchesUf(group));
  const total = sumCounts(kept);

  // Each facet counted with the OTHER one applied, never itself.
  const forStatus = groups.filter(matchesUf);
  const statusOptions: FacetCount[] = BUSINESS_STATUSES.map((status) => ({
    value: status,
    count: sumCounts(forStatus.filter((group) => group.is_active === (status === "active"))),
  }));

  const byUf = new Map<string, number>();

  for (const group of groups.filter(matchesStatus)) {
    byUf.set(group.uf, (byUf.get(group.uf) ?? 0) + group.count);
  }

  // Every UF present, plus a selected one that has zero now, so its chip
  // keeps a count instead of vanishing.
  const ufOptions: FacetCount[] = BRAZILIAN_UFS.filter(
    (uf) => (byUf.get(uf) ?? 0) > 0 || ufFilter?.has(uf),
  ).map((uf) => ({ value: uf, count: byUf.get(uf) ?? 0 }));

  return {
    total,
    searchMeta: {
      total,
      withErpCode: kept.reduce((sum, group) => sum + group.withErpCode, 0),
      // A breakdown by the UF facet: the status filter applies, UF not.
      topStates: topPlaces(byUf),
      topCities,
      facets: { status: statusOptions, uf: ufOptions },
    },
  };
}

export {
  BRAZILIAN_UFS,
  BUSINESS_SORT,
  BUSINESS_SORT_FALLBACK,
  BUSINESS_SORT_KEYS,
  BUSINESS_STATUSES,
  TOP_PLACES,
  businessListWhere,
  cityLabel,
  digitsOf,
  summarizeBusinessList,
  topPlaces,
  type BusinessGroupCount,
  type BusinessListFilters,
  type BusinessListSearchMeta,
  type BusinessSortKey,
  type BusinessStatus,
  type BusinessUf,
  type PlaceCount,
};
