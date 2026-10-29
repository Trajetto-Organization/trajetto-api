import type { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

import {
  ACTIVE_STATUSES,
  YES_NO,
  activeStatusOf,
  disjunctiveFacets,
  facetCount,
  isActiveFilter,
  yesNoFilter,
  yesNoOf,
  type ActiveStatus,
  type YesNo,
} from "@/shared/delivery/catalog-list";
import {
  OCCURRENCE_CATEGORIES,
  type OccurrenceCategoryKey,
} from "../../rules/occurrence-category-rules";

/**
 * The Tipos de Ocorrência table on the server (decision 8.8): its order, its
 * Status/Impeditiva/Foto filters, the cards and the filter counts, over the
 * whole company.
 */

/** Same ids as the web table's columns: the URL value is the column id. */
const OCCURRENCE_TYPE_SORT_KEYS = ["name", "created_at", "updated_at"] as const;

type OccurrenceTypeSortKey = (typeof OCCURRENCE_TYPE_SORT_KEYS)[number];

const OCCURRENCE_TYPE_SORT_FALLBACK = {
  sort: "created_at",
  order: "desc",
} as const;

const OCCURRENCE_TYPE_SORT: SortSpec<
  OccurrenceTypeSortKey,
  Prisma.OccurrenceTypeOrderByWithRelationInput
> = {
  keys: OCCURRENCE_TYPE_SORT_KEYS,
  fallback: OCCURRENCE_TYPE_SORT_FALLBACK,
  columns: {
    name: (order: SortOrder) => ({ name: order }),
    created_at: (order: SortOrder) => ({ created_at: order }),
    updated_at: (order: SortOrder) => ({ updated_at: order }),
  },
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface OccurrenceTypeListFilters {
  businessId: string;
  search?: string;
  statuses?: ActiveStatus[];
  blocking?: YesNo[];
  photo?: YesNo[];
  /** Decision 14.3: Entrega / Não entrega / Pausa. */
  categories?: OccurrenceCategoryKey[];
}

/** The category filter; none (or every value) keeps every type. */
function categoryFilter(
  categories: OccurrenceCategoryKey[] | undefined,
): OccurrenceCategoryKey[] | undefined {
  if (!categories || categories.length === 0) return undefined;

  const unique = Array.from(new Set(categories));

  return unique.length === OCCURRENCE_CATEGORIES.length ? undefined : unique;
}

/**
 * The listing's `where`. `withFacets: false` is the base the counts are
 * grouped over (search only): the three filters are columns of the row, so
 * one GROUP BY over them answers every count (see summarizeOccurrenceTypeList).
 */
function occurrenceTypeListWhere(
  filters: OccurrenceTypeListFilters,
  { withFacets }: { withFacets: boolean },
): Prisma.OccurrenceTypeWhereInput {
  const and: Prisma.OccurrenceTypeWhereInput[] = [];

  if (withFacets) {
    const isActive = isActiveFilter(filters.statuses);
    const blocks = yesNoFilter(filters.blocking);
    const photo = yesNoFilter(filters.photo);

    if (isActive !== undefined) and.push({ is_active: isActive });
    if (blocks !== undefined) and.push({ blocks_delivery: blocks });
    if (photo !== undefined) and.push({ requires_photo: photo });

    const categories = categoryFilter(filters.categories);

    if (categories) and.push({ category: { in: categories } });
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    and.push(
      buildSearchOr<Prisma.OccurrenceTypeWhereInput>([
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

/** Types per combination of the three filtered columns, over the base. */
interface OccurrenceTypeGroup {
  is_active: boolean;
  blocks_delivery: boolean;
  requires_photo: boolean;
  category: OccurrenceCategoryKey;
  count: number;
}

interface OccurrenceTypeListSearchMeta {
  /** Cards, each without its own filter (the disjunctive rule). */
  total: number;
  active: number;
  blocking: number;
  requiringPhoto: number;
  facets: {
    status: FacetCount[];
    blocking: FacetCount[];
    photo: FacetCount[];
    category: FacetCount[];
  };
}

function summarizeOccurrenceTypeList(
  groups: ReadonlyArray<OccurrenceTypeGroup>,
  filters: Pick<
    OccurrenceTypeListFilters,
    "statuses" | "blocking" | "photo" | "categories"
  >,
): { total: number; searchMeta: OccurrenceTypeListSearchMeta } {
  const { total, facets } = disjunctiveFacets(
    groups.map((group) => ({
      values: {
        status: activeStatusOf(group.is_active),
        blocking: yesNoOf(group.blocks_delivery),
        photo: yesNoOf(group.requires_photo),
        category: group.category,
      },
      count: group.count,
    })),
    {
      status: filters.statuses,
      blocking: filters.blocking,
      photo: filters.photo,
      category: filters.categories,
    },
    {
      status: ACTIVE_STATUSES,
      blocking: YES_NO,
      photo: YES_NO,
      category: OCCURRENCE_CATEGORIES,
    },
  );

  const active = facetCount(facets.status, "active");

  return {
    total,
    searchMeta: {
      // The Total card is the Status breakdown's whole: Ativos is a share of it.
      total: active + facetCount(facets.status, "inactive"),
      active,
      blocking: facetCount(facets.blocking, "yes"),
      requiringPhoto: facetCount(facets.photo, "yes"),
      facets,
    },
  };
}

export {
  categoryFilter,
  OCCURRENCE_TYPE_SORT,
  OCCURRENCE_TYPE_SORT_FALLBACK,
  OCCURRENCE_TYPE_SORT_KEYS,
  occurrenceTypeListWhere,
  summarizeOccurrenceTypeList,
  type OccurrenceTypeGroup,
  type OccurrenceTypeListFilters,
  type OccurrenceTypeListSearchMeta,
  type OccurrenceTypeSortKey,
};
