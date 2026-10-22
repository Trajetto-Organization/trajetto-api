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
} from "@/shared/delivery/catalog-list";

/**
 * The Motivos de status table on the server (decision 8.8): its order, its
 * Status filter, the cards and the filter counts, over the whole company.
 */

/** Same ids as the web table's columns: the URL value is the column id. */
const STATUS_REASON_SORT_KEYS = ["name", "created_at", "updated_at"] as const;

type StatusReasonSortKey = (typeof STATUS_REASON_SORT_KEYS)[number];

const STATUS_REASON_SORT_FALLBACK = {
  sort: "created_at",
  order: "desc",
} as const;

const STATUS_REASON_SORT: SortSpec<
  StatusReasonSortKey,
  Prisma.StatusChangeReasonOrderByWithRelationInput
> = {
  keys: STATUS_REASON_SORT_KEYS,
  fallback: STATUS_REASON_SORT_FALLBACK,
  columns: {
    name: (order: SortOrder) => ({ name: order }),
    created_at: (order: SortOrder) => ({ created_at: order }),
    updated_at: (order: SortOrder) => ({ updated_at: order }),
  },
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface StatusReasonListFilters {
  businessId: string;
  search?: string;
  statuses?: ActiveStatus[];
}

/**
 * The listing's `where`. `withFacets: false` is the base the counts are taken
 * over (search only): Status is the only filter.
 */
function statusReasonListWhere(
  filters: StatusReasonListFilters,
  { withFacets }: { withFacets: boolean },
): Prisma.StatusChangeReasonWhereInput {
  const and: Prisma.StatusChangeReasonWhereInput[] = [];

  const isActive = withFacets ? isActiveFilter(filters.statuses) : undefined;

  if (isActive !== undefined) and.push({ is_active: isActive });

  const term = filters.search?.trim() ?? "";

  if (term) {
    and.push(
      buildSearchOr<Prisma.StatusChangeReasonWhereInput>([
        { id: { contains: term, mode: "insensitive" } },
        { name: { contains: term, mode: "insensitive" } },
        { description: { contains: term, mode: "insensitive" } },
      ]),
    );
  }

  return {
    businessId: filters.businessId,
    ...(and.length > 0 && { AND: and }),
  };
}

/** Reasons per status over the base. */
interface StatusReasonGroup {
  is_active: boolean;
  count: number;
}

interface StatusReasonListSearchMeta {
  /** Cards: the search, without the Status filter (its own breakdown). */
  total: number;
  active: number;
  /** Of those, the ones some status change already cites. */
  used: number;
  facets: { status: FacetCount[] };
}

function summarizeStatusReasonList(
  groups: ReadonlyArray<StatusReasonGroup>,
  used: number,
  filters: Pick<StatusReasonListFilters, "statuses">,
): { total: number; searchMeta: StatusReasonListSearchMeta } {
  const { total, facets } = disjunctiveFacets(
    groups.map((group) => ({
      values: { status: group.is_active ? "active" : "inactive" },
      count: group.count,
    })),
    { status: filters.statuses },
    { status: ACTIVE_STATUSES },
  );

  return {
    total,
    searchMeta: {
      total: groups.reduce((sum, group) => sum + group.count, 0),
      active: facetCount(facets.status, "active"),
      used,
      facets,
    },
  };
}

export {
  STATUS_REASON_SORT,
  STATUS_REASON_SORT_FALLBACK,
  STATUS_REASON_SORT_KEYS,
  statusReasonListWhere,
  summarizeStatusReasonList,
  type StatusReasonGroup,
  type StatusReasonListFilters,
  type StatusReasonListSearchMeta,
  type StatusReasonSortKey,
};
