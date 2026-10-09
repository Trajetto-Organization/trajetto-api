import type { Prisma } from "@prisma/client";

import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import { escapeLikePattern } from "@/shared/utils/like-pattern";
import { buildSearchOr } from "@/shared/pagination/search-or";

import { sumCounts, type FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

/**
 * The occurrence feed's server-side table: what it sorts by, what it filters
 * by, and how the cards and filter counts are derived (decision 8.8; the
 * pilot of the list contract in shared/pagination).
 */

const OCCURRENCE_SEVERITIES = ["blocking", "informational"] as const;

type OccurrenceSeverity = (typeof OCCURRENCE_SEVERITIES)[number];

/**
 * Decision 14.3: the categories a delivery_occurrence row can have. PAUSE is
 * a DriverPause, never a row of this feed.
 */
const OCCURRENCE_FEED_CATEGORIES = ["DELIVERED", "NOT_DELIVERED"] as const;

type OccurrenceFeedCategory = (typeof OCCURRENCE_FEED_CATEGORIES)[number];

const OCCURRENCE_DELIVERY_STATUSES = [
  "PENDING",
  "IN_TRANSIT",
  "DELIVERED",
  "FAILED",
  "CANCELLED",
] as const satisfies readonly DeliveryStatus[];

/**
 * Same ids as the web table's columns, so the URL value is the column id.
 * Each key orders by the value its column renders: `created_at` is the
 * arrival ("Recebida em"), not occurred_at, which an offline report dates up
 * to 7 days earlier and which no index serves.
 */
const OCCURRENCE_SORT_KEYS = [
  "created_at",
  "typeName",
  "blocking",
  "recipient",
  "reporter",
] as const;

type OccurrenceSortKey = (typeof OCCURRENCE_SORT_KEYS)[number];

const OCCURRENCE_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

type OrderBy = Prisma.DeliveryOccurrenceOrderByWithRelationInput;

const OCCURRENCE_SORT: SortSpec<OccurrenceSortKey, OrderBy> = {
  keys: OCCURRENCE_SORT_KEYS,
  fallback: OCCURRENCE_SORT_FALLBACK,
  columns: {
    created_at: (order: SortOrder) => ({ created_at: order }),
    typeName: (order: SortOrder) => ({ occurrenceType: { name: order } }),
    blocking: (order: SortOrder) => ({
      occurrenceType: { blocks_delivery: order },
    }),
    recipient: (order: SortOrder) => ({
      delivery: { recipient_name: order },
    }),
    reporter: (order: SortOrder) => ({ reportedBy: { name: order } }),
  },
  // Newest first inside a tie; the id breaks what created_at cannot (a batch
  // written in one millisecond).
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface OccurrenceFeedFilters {
  businessId: string;
  /**
   * Defence in depth: the route refuses driver tokens, so this is set only
   * if a caller bypasses it; it narrows the feed to that driver's deliveries.
   */
  driverId?: string;
  search?: string;
  severity?: OccurrenceSeverity[];
  /** Decision 14.3: "Entrega" and/or "Não entrega"; none (or both) is no filter. */
  category?: OccurrenceFeedCategory[];
  occurrenceTypeIds?: string[];
  deliveryStatuses?: DeliveryStatus[];
  /**
   * Set only by the Prisma repository (repositories/occurrence-search.ts):
   * the recipient and type-name arms of `search`, already resolved to ids
   * through their indexes. Same matches, without a join per row.
   */
  searchMatches?: {
    deliveryIds: string[];
    occurrenceTypeIds: string[];
    matchOccurrenceId: boolean;
  };
}

/** The one category to match, or undefined when the filter keeps both. */
function selectedCategory(
  category: OccurrenceFeedCategory[] | undefined,
): OccurrenceFeedCategory | undefined {
  const selected = new Set(category ?? []);

  return selected.size === 1 ? [...selected][0] : undefined;
}

/**
 * Both severities selected is no filter at all, and neither is one either.
 * Returns the `blocks_delivery` value to match, or undefined.
 */
function severityAsBlocking(
  severity: OccurrenceSeverity[] | undefined,
): boolean | undefined {
  const selected = new Set(severity ?? []);

  if (selected.size !== 1) return undefined;

  return selected.has("blocking");
}

/**
 * The feed's `where`, with the type and severity facets optional.
 *
 * `withTypeFacets: false` is the base the counts are grouped over: type and
 * severity are both properties of the occurrence's type, so one GROUP BY by
 * type over this base yields the cards, the type options and the pager total
 * (see summarizeOccurrenceFeed) without a second scan.
 */
function occurrenceFeedWhere(
  filters: OccurrenceFeedFilters,
  { withTypeFacets }: { withTypeFacets: boolean },
): Prisma.DeliveryOccurrenceWhereInput {
  const and: Prisma.DeliveryOccurrenceWhereInput[] = [];

  if (filters.driverId) {
    and.push({ delivery: { driverId: filters.driverId } });
  }

  if (filters.deliveryStatuses?.length) {
    and.push({ delivery: { status: { in: filters.deliveryStatuses } } });
  }

  if (withTypeFacets) {
    if (filters.occurrenceTypeIds?.length) {
      and.push({ occurrenceTypeId: { in: filters.occurrenceTypeIds } });
    }

    const category = selectedCategory(filters.category);

    if (category) {
      and.push({ category });
    }

    const blocking = severityAsBlocking(filters.severity);

    // Severity is a property of problems: a proof (DELIVERED, never
    // blocking) must not count as "informational".
    if (blocking !== undefined) {
      and.push({
        category: "NOT_DELIVERED",
        occurrenceType: { blocks_delivery: blocking },
      });
    }
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    const matches = filters.searchMatches;

    if (matches) {
      // Resolved through their indexes (repositories/occurrence-search.ts);
      // an empty `in` would match nothing, so an empty list drops its arm.
      const arms: Prisma.DeliveryOccurrenceWhereInput[] = [
        ...(matches.matchOccurrenceId
          ? [{ id: { contains: escapeLikePattern(term), mode: "insensitive" as const } }]
          : []),
        ...(matches.deliveryIds.length > 0
          ? [{ deliveryId: { in: matches.deliveryIds } }]
          : []),
        ...(matches.occurrenceTypeIds.length > 0
          ? [{ occurrenceTypeId: { in: matches.occurrenceTypeIds } }]
          : []),
      ];

      // No arm left is "nothing matches", never "no search" (an empty OR
      // would drop the filter and list everything).
      and.push(arms.length > 0 ? { OR: arms } : { id: { in: [] } });
    } else {
      and.push(
        buildSearchOr<Prisma.DeliveryOccurrenceWhereInput>([
          // Both ids are copiable from the row menu, so both have to come
          // back when pasted into the search.
          { id: { contains: term, mode: "insensitive" } },
          { deliveryId: { contains: term, mode: "insensitive" } },
          {
            delivery: {
              recipient_name: { contains: term, mode: "insensitive" },
            },
          },
          { occurrenceType: { name: { contains: term, mode: "insensitive" } } },
        ]),
      );
    }
  }

  // The tenant stays a top-level key: the (businessId, created_at) index
  // serves every read of the feed.
  return { businessId: filters.businessId, ...(and.length > 0 && { AND: and }) };
}

/** Occurrences per type over the base (scope, search and status; no type facets). */
interface OccurrenceTypeCount {
  id: string;
  name: string;
  blocks_delivery: boolean;
  /**
   * The type's category. Equal to the rows' own copy: a used type's category
   * is immutable (OCCURRENCE_TYPE_CATEGORY_LOCKED). Absent reads as
   * NOT_DELIVERED, today's vocabulary.
   */
  category?: OccurrenceFeedCategory | "PAUSE";
  count: number;
}

interface OccurrenceFeedSearchMeta {
  /** Cards: every filter except severity, so the breakdown stays whole. */
  total: number;
  /** Problems that blocked the delivery (NOT_DELIVERED only). */
  blocking: number;
  /** Problems recorded without changing the delivery (NOT_DELIVERED only). */
  informational: number;
  /** Decision 14.3: proofs recorded as DELIVERED occurrences. */
  delivered: number;
  facets: {
    severity: FacetCount[];
    category: FacetCount[];
    occurrenceTypeId: FacetCount[];
  };
}

/**
 * The pager total, the cards and the filter options, from the per-type counts.
 *
 * Exact because severity and type are both functions of the type: the rows
 * matching every facet are the base rows of the types the facets keep.
 */
function summarizeOccurrenceFeed(
  typeCounts: OccurrenceTypeCount[],
  filters: Pick<OccurrenceFeedFilters, "severity" | "category" | "occurrenceTypeIds">,
): { total: number; searchMeta: OccurrenceFeedSearchMeta } {
  const blocking = severityAsBlocking(filters.severity);
  const category = selectedCategory(filters.category);

  const categoryOf = (type: OccurrenceTypeCount) => type.category ?? "NOT_DELIVERED";

  const selectedTypes = filters.occurrenceTypeIds?.length
    ? new Set(filters.occurrenceTypeIds)
    : undefined;

  const keptByType = (type: OccurrenceTypeCount) =>
    !selectedTypes || selectedTypes.has(type.id);

  // Severity only ever matches problems (see occurrenceFeedWhere).
  const keptBySeverity = (type: OccurrenceTypeCount) =>
    blocking === undefined ||
    (categoryOf(type) === "NOT_DELIVERED" && type.blocks_delivery === blocking);

  const keptByCategory = (type: OccurrenceTypeCount) =>
    category === undefined || categoryOf(type) === category;

  // The cards: every facet except severity, which they break down.
  const cardTypes = typeCounts.filter(
    (type) => keptByType(type) && keptByCategory(type),
  );

  const problems = cardTypes.filter((type) => categoryOf(type) === "NOT_DELIVERED");

  const blockingCount = sumCounts(problems.filter((type) => type.blocks_delivery));
  const informationalCount = sumCounts(problems.filter((type) => !type.blocks_delivery));
  const deliveredCount = sumCounts(
    cardTypes.filter((type) => categoryOf(type) === "DELIVERED"),
  );

  // The category facet: every facet except its own.
  const categoryBase = typeCounts.filter(
    (type) => keptByType(type) && keptBySeverity(type),
  );

  // Every facet but the type one. A selected type stays listed (with what it
  // would bring now) so its chip keeps a name.
  const keptByOthers = (type: OccurrenceTypeCount) =>
    keptBySeverity(type) && keptByCategory(type);

  const typeOptions: FacetCount[] = typeCounts
    .filter((type) => keptByOthers(type) || selectedTypes?.has(type.id))
    .map((type) => ({
      value: type.id,
      label: type.name,
      count: keptByOthers(type) ? type.count : 0,
    }))
    .sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "", "pt-BR"));

  return {
    total: sumCounts(
      typeCounts.filter(
        (type) => keptByType(type) && keptBySeverity(type) && keptByCategory(type),
      ),
    ),
    searchMeta: {
      total: sumCounts(cardTypes),
      blocking: blockingCount,
      informational: informationalCount,
      delivered: deliveredCount,
      facets: {
        severity: [
          { value: "blocking", count: blockingCount },
          { value: "informational", count: informationalCount },
        ],
        category: OCCURRENCE_FEED_CATEGORIES.map((value) => ({
          value,
          count: sumCounts(categoryBase.filter((type) => categoryOf(type) === value)),
        })),
        occurrenceTypeId: typeOptions,
      },
    },
  };
}

export {
  OCCURRENCE_DELIVERY_STATUSES,
  OCCURRENCE_FEED_CATEGORIES,
  OCCURRENCE_SEVERITIES,
  OCCURRENCE_SORT,
  OCCURRENCE_SORT_FALLBACK,
  OCCURRENCE_SORT_KEYS,
  occurrenceFeedWhere,
  selectedCategory,
  severityAsBlocking,
  summarizeOccurrenceFeed,
  type OccurrenceFeedCategory,
  type OccurrenceFeedFilters,
  type OccurrenceFeedSearchMeta,
  type OccurrenceSeverity,
  type OccurrenceSortKey,
  type OccurrenceTypeCount,
};
