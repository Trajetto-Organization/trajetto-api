import { type PrismaClient } from "@prisma/client";

import { escapeLikePattern } from "@/shared/utils/like-pattern";

import type { OccurrenceFeedFilters } from "../usecases/list-occurrences/occurrence-feed";
import {
  DELIVERY_SEARCH_TEXT,
  SEARCH_FIELD_SEPARATOR,
  SEARCH_PREFILTER_CAP,
  SEARCH_PREFILTER_MIN_LENGTH,
} from "./delivery-search";

/**
 * The occurrence feed's search through the deliveries' trigram index
 * (docs/desempenho/banco-2026-10.md §9, limit 3).
 *
 * The feed's search is an OR over the occurrence's id and deliveryId, the
 * delivery's recipient and the type's name, checked row by row for every
 * occurrence the company ever had (605 ms on a 300k-delivery tenant). Here
 * the arms are resolved first, each by an index:
 * - the delivery's id and recipient through delivery_search_trgm_idx (its
 *   text holds both; rechecked on the two columns, since it also holds code,
 *   keys and city);
 * - the type name over the company's few types;
 * - the occurrence's own id only when the term could be part of one: ids are
 *   UUIDs the database generates (the one write path sets none), so a term
 *   with any character outside hex digits and "-" cannot match it.
 * The feed then reads `deliveryId IN (...) OR occurrenceTypeId IN (...)`
 * through their indexes. Same matches: same columns, case-insensitive
 * literal "contains" (% and _ escaped, as buildSearchOr does).
 */
interface OccurrenceSearchMatches {
  /** Deliveries of the company whose id or recipient matched the term. */
  deliveryIds: string[];
  /** The company's occurrence types whose name matched the term. */
  occurrenceTypeIds: string[];
  /** Whether the term could be part of an occurrence id (a UUID). */
  matchOccurrenceId: boolean;
}

/** What a piece of a UUID can hold. */
const UUID_FRAGMENT = /^[0-9a-f-]+$/i;

type NarrowedOccurrenceFilters = OccurrenceFeedFilters & {
  searchMatches?: OccurrenceSearchMatches;
};

/**
 * The filters with the joined search arms resolved to ids, or unchanged when
 * the index cannot help (short term, a separator in it, or more recipient
 * matches than the cap — then the ILIKE path reads the company once anyway).
 */
async function narrowOccurrenceSearch(
  prisma: PrismaClient,
  filters: OccurrenceFeedFilters,
): Promise<NarrowedOccurrenceFilters> {
  const term = filters.search?.trim() ?? "";

  if ([...term].length < SEARCH_PREFILTER_MIN_LENGTH || term.includes(SEARCH_FIELD_SEPARATOR)) {
    return filters;
  }

  const pattern = `%${escapeLikePattern(term)}%`;

  // An occurrence's delivery is always of the occurrence's company (its
  // businessId is copied from the delivery), so the company's deliveries are
  // the whole candidate set.
  const deliveries = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "delivery"
    WHERE "businessId" = ${filters.businessId}
      AND ${DELIVERY_SEARCH_TEXT} ILIKE ${pattern}
      AND ("recipient_name" ILIKE ${pattern} OR "id" ILIKE ${pattern})
    LIMIT ${SEARCH_PREFILTER_CAP + 1}
  `;

  if (deliveries.length > SEARCH_PREFILTER_CAP) return filters;

  // Types are per company, and an occurrence only ever points at one of its
  // own company's (the report use cases check it).
  const types = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "occurrence_type"
    WHERE "businessId" = ${filters.businessId}
      AND "name" ILIKE ${pattern}
  `;

  return {
    ...filters,
    searchMatches: {
      deliveryIds: deliveries.map((row) => row.id),
      occurrenceTypeIds: types.map((row) => row.id),
      matchOccurrenceId: UUID_FRAGMENT.test(term),
    },
  };
}

export { narrowOccurrenceSearch };
export type { NarrowedOccurrenceFilters, OccurrenceSearchMatches };
