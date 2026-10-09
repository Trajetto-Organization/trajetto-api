import type { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { sumCounts, type FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

/**
 * The branch list's server-side table (decision 8.8): what it sorts by, what
 * it filters by and how the cards are derived — over the whole company,
 * never over the ten rows a page holds. Both old screens counted "Com
 * código ERP" and "Com nome fantasia" on the loaded page.
 */

const BRAZILIAN_UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT",
  "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP",
  "TO",
] as const;

type BranchUf = (typeof BRAZILIAN_UFS)[number];

/** The status facet: `is_active` as the words the URL carries. */
const BRANCH_STATUSES = ["active", "inactive"] as const;

type BranchStatus = (typeof BRANCH_STATUSES)[number];

/** Same ids as the web table's columns, so the URL value is the column id. */
const BRANCH_SORT_KEYS = [
  "created_at",
  "updated_at",
  "corporate_reason",
  "fantasy_name",
  "cnpj",
  "city",
  "uf",
  "erp_code",
  "is_active",
] as const;

type BranchSortKey = (typeof BRANCH_SORT_KEYS)[number];

const BRANCH_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

type OrderBy = Prisma.BranchOrderByWithRelationInput;

const BRANCH_SORT: SortSpec<BranchSortKey, OrderBy> = {
  keys: BRANCH_SORT_KEYS,
  fallback: BRANCH_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    updated_at: (order: SortOrder) => ({ updated_at: order }),
    corporate_reason: (order: SortOrder) => ({ corporate_reason: order }),
    // Branches without a trade name sort last either way (Postgres puts
    // NULLs last ascending); stated so the twin can mirror it.
    fantasy_name: (order: SortOrder) => ({
      fantasy_name: { sort: order, nulls: "last" },
    }),
    cnpj: (order: SortOrder) => ({ cnpj: order }),
    city: (order: SortOrder) => ({ city: order }),
    uf: (order: SortOrder) => ({ uf: order }),
    erp_code: (order: SortOrder) => ({
      erp_code: { sort: order, nulls: "last" },
    }),
    is_active: (order: SortOrder) => ({ is_active: order }),
  },
  // Newest first inside a tie; the id breaks what created_at cannot.
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface BranchListFilters {
  businessId: string;
  search?: string;
  statuses?: BranchStatus[];
  ufs?: BranchUf[];
}

/** Digits of a term, for the columns stored as digits (CNPJ, CEP, phone). */
function digitsOf(term: string): { digits: string; phoneDigits: string } {
  const digits = term.replace(/\D/g, "");
  const phoneDigits =
    digits.startsWith("55") && digits.length > 10 ? digits.slice(2) : digits;

  return { digits, phoneDigits };
}

/**
 * The list's `where`. `except` drops one facet, for the breakdown that facet
 * is counted over (the disjunctive rule).
 */
function branchListWhere(
  filters: BranchListFilters,
  { except }: { except?: "status" | "uf" | "facets" } = {},
): Prisma.BranchWhereInput {
  const and: Prisma.BranchWhereInput[] = [];

  const keepStatus = except !== "status" && except !== "facets";
  const keepUf = except !== "uf" && except !== "facets";

  // Both statuses selected is no filter at all.
  if (keepStatus && filters.statuses?.length === 1) {
    and.push({ is_active: filters.statuses[0] === "active" });
  }

  if (keepUf && filters.ufs?.length) {
    and.push({ uf: { in: filters.ufs } });
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    const { digits, phoneDigits } = digitsOf(term);

    and.push(
      buildSearchOr<Prisma.BranchWhereInput>([
        { id: { contains: term, mode: "insensitive" } },
        { corporate_reason: { contains: term, mode: "insensitive" } },
        { fantasy_name: { contains: term, mode: "insensitive" } },
        { street: { contains: term, mode: "insensitive" } },
        { city: { contains: term, mode: "insensitive" } },
        { uf: { contains: term, mode: "insensitive" } },
        { cnae: { contains: term, mode: "insensitive" } },
        { erp_code: { contains: term, mode: "insensitive" } },
        { responsible_name: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
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
  // serves every read of the list, and no filter can widen it.
  return { businessId: filters.businessId, ...(and.length > 0 && { AND: and }) };
}

/** Branches per (is_active, uf) over the base: search applied, facets not. */
interface BranchGroupCount {
  is_active: boolean;
  uf: string;
  count: number;
  withErpCode: number;
}

interface BranchListSearchMeta {
  /** Cards: every filter applied, except for a card broken down by a facet. */
  total: number;
  /** Active branches under every filter but the status one (disjunctive rule). */
  active: number;
  withErpCode: number;
  withFantasyName: number;
  facets: { status: FacetCount[]; uf: FacetCount[] };
}

/**
 * The pager total, the cards and both facets' options from one GROUP BY
 * (is_active, uf) over the base. Exact because both facets are functions of
 * the row's own columns. `withFantasyName` is counted apart (it needs a
 * non-blank test a GROUP BY count cannot make) over the fully filtered set.
 */
function summarizeBranchList(
  groups: BranchGroupCount[],
  withFantasyName: number,
  filters: Pick<BranchListFilters, "statuses" | "ufs">,
): { total: number; searchMeta: BranchListSearchMeta } {
  const statusFilter =
    filters.statuses?.length === 1 ? filters.statuses[0] : undefined;
  const ufFilter = filters.ufs?.length ? new Set<string>(filters.ufs) : null;

  const matchesStatus = (group: BranchGroupCount) =>
    !statusFilter || group.is_active === (statusFilter === "active");
  const matchesUf = (group: BranchGroupCount) =>
    !ufFilter || ufFilter.has(group.uf);

  const kept = groups.filter((group) => matchesStatus(group) && matchesUf(group));
  const total = sumCounts(kept);

  // Each facet counted with the OTHER one applied, never itself.
  const forStatus = groups.filter(matchesUf);
  const statusOptions: FacetCount[] = BRANCH_STATUSES.map((status) => ({
    value: status,
    count: sumCounts(
      forStatus.filter((group) => group.is_active === (status === "active")),
    ),
  }));

  const forUf = groups.filter(matchesStatus);
  const byUf = new Map<string, number>();

  for (const group of forUf) {
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
      // A breakdown by the status facet: the UF filter applies, status not.
      active: sumCounts(forStatus.filter((group) => group.is_active)),
      withErpCode: kept.reduce((sum, group) => sum + group.withErpCode, 0),
      withFantasyName,
      facets: { status: statusOptions, uf: ufOptions },
    },
  };
}

export {
  BRANCH_SORT,
  BRANCH_SORT_FALLBACK,
  BRANCH_SORT_KEYS,
  BRANCH_STATUSES,
  BRAZILIAN_UFS,
  branchListWhere,
  digitsOf,
  summarizeBranchList,
  type BranchGroupCount,
  type BranchListFilters,
  type BranchListSearchMeta,
  type BranchSortKey,
  type BranchStatus,
  type BranchUf,
};
