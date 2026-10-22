import type { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

import {
  ACTIVE_STATUSES,
  disjunctiveFacets,
  facetCount,
  isActiveFilter,
  type ActiveStatus,
  type DimensionGroup,
} from "@/shared/delivery/catalog-list";

/**
 * The Embarcadores table on the server (decision 8.8): its order, its Status
 * filter, the cards and the filter counts, over the whole company.
 */

/** Same ids as the web table's columns: the URL value is the column id. */
const SHIPPER_SORT_KEYS = ["name", "created_at", "updated_at"] as const;

type ShipperSortKey = (typeof SHIPPER_SORT_KEYS)[number];

const SHIPPER_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

const SHIPPER_SORT: SortSpec<
  ShipperSortKey,
  Prisma.ShipperOrderByWithRelationInput
> = {
  keys: SHIPPER_SORT_KEYS,
  fallback: SHIPPER_SORT_FALLBACK,
  columns: {
    name: (order: SortOrder) => ({ name: order }),
    created_at: (order: SortOrder) => ({ created_at: order }),
    updated_at: (order: SortOrder) => ({ updated_at: order }),
  },
  // Without it, OFFSET repeats or skips shippers created in the same instant.
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

/** Digits and the CNPJ mask's own characters, nothing else. */
const CNPJ_FRAGMENT = /^[\d./\-\s]+$/;

/**
 * The digits of a term typed as a CNPJ ("90.123.456/0001-70"), or undefined
 * when the term is a name. The CNPJ column holds digits only; rewriting any
 * term with a digit ("Loja 2") to its digits made "2" match nearly every CNPJ.
 */
function cnpjSearchDigits(term: string): string | undefined {
  if (!CNPJ_FRAGMENT.test(term)) return undefined;

  return term.replace(/\D/g, "") || undefined;
}

interface ShipperListFilters {
  businessId: string;
  search?: string;
  statuses?: ActiveStatus[];
}

/**
 * The listing's `where`. `withFacets: false` is the base the counts are
 * grouped over (search only): the Status filter is the only facet, so its
 * counts and the cards never include it.
 */
function shipperListWhere(
  filters: ShipperListFilters,
  { withFacets }: { withFacets: boolean },
): Prisma.ShipperWhereInput {
  const and: Prisma.ShipperWhereInput[] = [];

  const isActive = withFacets ? isActiveFilter(filters.statuses) : undefined;

  if (isActive !== undefined) and.push({ is_active: isActive });

  const term = filters.search?.trim() ?? "";

  if (term) {
    // A masked CNPJ is matched by its digits; a name keeps its digits.
    const digits = cnpjSearchDigits(term);

    and.push(
      buildSearchOr<Prisma.ShipperWhereInput>([
        // The id is copiable from the row menu, so pasting it must find it.
        { id: { contains: term, mode: "insensitive" } },
        { name: { contains: term, mode: "insensitive" } },
        { cnpj: { contains: term, mode: "insensitive" } },
        ...(digits && digits !== term ? [{ cnpj: { contains: digits } }] : []),
        { email: { contains: term, mode: "insensitive" } },
      ]),
    );
  }

  // The tenant stays a top-level key: the (businessId, …) indexes serve it.
  return {
    businessId: filters.businessId,
    ...(and.length > 0 && { AND: and }),
  };
}

/** Shippers per status over the base, with how many of them carry a CNPJ. */
interface ShipperGroup {
  is_active: boolean;
  count: number;
  withCnpj: number;
}

interface ShipperListSearchMeta {
  /** Cards: the search, without the Status filter (its own breakdown). */
  total: number;
  active: number;
  withCnpj: number;
  facets: { status: FacetCount[] };
}

function summarizeShipperList(
  groups: ReadonlyArray<ShipperGroup>,
  filters: Pick<ShipperListFilters, "statuses">,
): { total: number; searchMeta: ShipperListSearchMeta } {
  const dimensions: DimensionGroup<"status">[] = groups.map((group) => ({
    values: { status: group.is_active ? "active" : "inactive" },
    count: group.count,
  }));

  const { total, facets } = disjunctiveFacets(
    dimensions,
    { status: filters.statuses },
    { status: ACTIVE_STATUSES },
  );

  return {
    total,
    searchMeta: {
      total: groups.reduce((sum, group) => sum + group.count, 0),
      active: facetCount(facets.status, "active"),
      withCnpj: groups.reduce((sum, group) => sum + group.withCnpj, 0),
      facets,
    },
  };
}

export {
  SHIPPER_SORT,
  SHIPPER_SORT_FALLBACK,
  SHIPPER_SORT_KEYS,
  cnpjSearchDigits,
  shipperListWhere,
  summarizeShipperList,
  type ShipperGroup,
  type ShipperListFilters,
  type ShipperListSearchMeta,
  type ShipperSortKey,
};
