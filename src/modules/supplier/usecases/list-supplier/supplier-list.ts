import type { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { sumCounts, type FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

/**
 * The supplier list's server-side table (decision 8.8): what it sorts by,
 * what it filters by and how the cards are derived — over the whole company,
 * never over the ten rows a page holds.
 */

/** The 27 federative units; the UF facet refuses anything else. */
const BRAZILIAN_UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT",
  "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP",
  "TO",
] as const;

type BrazilianUf = (typeof BRAZILIAN_UFS)[number];

/** Same ids as the web table's columns, so the URL value is the column id. */
const SUPPLIER_SORT_KEYS = [
  "created_at",
  "updated_at",
  "name",
  "cnpj",
  "city",
  "uf",
] as const;

type SupplierSortKey = (typeof SUPPLIER_SORT_KEYS)[number];

const SUPPLIER_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

type OrderBy = Prisma.SupplierOrderByWithRelationInput;

const SUPPLIER_SORT: SortSpec<SupplierSortKey, OrderBy> = {
  keys: SUPPLIER_SORT_KEYS,
  fallback: SUPPLIER_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    updated_at: (order: SortOrder) => ({ updated_at: order }),
    name: (order: SortOrder) => ({ name: order }),
    cnpj: (order: SortOrder) => ({ cnpj: order }),
    // Suppliers without an address sort last either way, as Postgres puts
    // NULLs last ascending; stated so the twin can mirror it.
    city: (order: SortOrder) => ({ city: { sort: order, nulls: "last" } }),
    uf: (order: SortOrder) => ({ uf: { sort: order, nulls: "last" } }),
  },
  // Newest first inside a tie; the id breaks what created_at cannot.
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface SupplierListFilters {
  businessId: string;
  search?: string;
  ufs?: BrazilianUf[];
}

/**
 * The digits of a term, for the columns stored as digits (CNPJ, CEP,
 * telephone). A phone typed with the country code matches the stored number
 * without it.
 */
function digitsOf(term: string): { digits: string; phoneDigits: string } {
  const digits = term.replace(/\D/g, "");
  const phoneDigits =
    digits.startsWith("55") && digits.length > 10 ? digits.slice(2) : digits;

  return { digits, phoneDigits };
}

/**
 * The list's `where`. `withUfFacet: false` is the base the UF breakdown is
 * grouped over (every filter but the UF itself — the disjunctive rule).
 */
function supplierListWhere(
  filters: SupplierListFilters,
  { withUfFacet }: { withUfFacet: boolean },
): Prisma.SupplierWhereInput {
  const and: Prisma.SupplierWhereInput[] = [];

  if (withUfFacet && filters.ufs?.length) {
    and.push({ uf: { in: filters.ufs } });
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    const { digits, phoneDigits } = digitsOf(term);

    and.push(
      buildSearchOr<Prisma.SupplierWhereInput>([
        { id: { contains: term, mode: "insensitive" } },
        { name: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { city: { contains: term, mode: "insensitive" } },
        { street: { contains: term, mode: "insensitive" } },
        ...(digits
          ? [
              { cnpj: { contains: digits } },
              { cep: { contains: digits } },
              { telephone: { contains: phoneDigits } },
            ]
          : []),
      ]),
    );
  }

  // The tenant stays a top-level key: the (businessId, created_at) index
  // serves every read of the list.
  return { businessId: filters.businessId, ...(and.length > 0 && { AND: and }) };
}

/** Suppliers per UF over the base (search applied, UF facet not). */
interface SupplierStateCount {
  uf: string | null;
  count: number;
  withTelephone: number;
  withEmail: number;
}

interface SupplierListSearchMeta {
  /** Cards: every filter applied, the UF one included. */
  total: number;
  withTelephone: number;
  withEmail: number;
  /** The three UFs with most suppliers in the base, e.g. "SP (12), MG (4)". */
  topStates: string;
  facets: { uf: FacetCount[] };
}

/**
 * The pager total, the cards and the UF options, from one GROUP BY uf.
 *
 * Exact because the UF facet is a function of the row's own column: the rows
 * matching every filter are the base rows of the UFs the facet keeps.
 */
function summarizeSupplierList(
  stateCounts: SupplierStateCount[],
  filters: Pick<SupplierListFilters, "ufs">,
): { total: number; searchMeta: SupplierListSearchMeta } {
  const selected = filters.ufs?.length ? new Set<string>(filters.ufs) : null;

  const kept = stateCounts.filter(
    (state) => !selected || (state.uf !== null && selected.has(state.uf)),
  );

  const total = sumCounts(kept);

  const ranked = stateCounts
    .filter((state) => state.uf !== null && state.count > 0)
    .sort((a, b) => b.count - a.count || (a.uf ?? "").localeCompare(b.uf ?? ""))
    .slice(0, 3);

  const byUf = new Map(
    stateCounts
      .filter((state) => state.uf !== null)
      .map((state) => [state.uf as string, state.count]),
  );

  // Every UF present in the base, plus a selected one that has zero now, so
  // its chip keeps a count instead of vanishing.
  const ufOptions: FacetCount[] = BRAZILIAN_UFS.filter(
    (uf) => byUf.has(uf) || selected?.has(uf),
  ).map((uf) => ({ value: uf, count: byUf.get(uf) ?? 0 }));

  return {
    total,
    searchMeta: {
      total,
      withTelephone: kept.reduce((sum, state) => sum + state.withTelephone, 0),
      withEmail: kept.reduce((sum, state) => sum + state.withEmail, 0),
      topStates:
        ranked.length > 0
          ? ranked.map((state) => `${state.uf} (${state.count})`).join(", ")
          : "N/A",
      facets: { uf: ufOptions },
    },
  };
}

export {
  BRAZILIAN_UFS,
  SUPPLIER_SORT,
  SUPPLIER_SORT_FALLBACK,
  SUPPLIER_SORT_KEYS,
  digitsOf,
  summarizeSupplierList,
  supplierListWhere,
  type BrazilianUf,
  type SupplierListFilters,
  type SupplierListSearchMeta,
  type SupplierSortKey,
  type SupplierStateCount,
};
