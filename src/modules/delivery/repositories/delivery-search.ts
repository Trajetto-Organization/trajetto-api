import { Prisma, type PrismaClient } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { escapeLikePattern } from "@/shared/utils/like-pattern";

import type { DeliveryListFilters } from "../usecases/list-delivery/delivery-list";

/**
 * The deliveries search through delivery_search_trgm_idx (migration
 * 20261007120100_delivery_search_trgm).
 *
 * The listing's search is an OR of ILIKEs over six columns and the driver's
 * name and CNH — no index serves that, so the page and each of its three
 * filter counts read every delivery the company ever made. Here the matching
 * ids come first, from one trigram index, and the listing becomes a read of
 * those ids. Same matches as the ILIKEs: the same columns, case-insensitive
 * "contains" with % and _ taken literally, and a column separator a typed term
 * cannot hold, so a match never spans two columns.
 */

/**
 * Byte for byte the expression of delivery_search_trgm_idx: the planner uses
 * an expression index only for the same expression.
 */
const DELIVERY_SEARCH_TEXT = Prisma.raw(
  `lower("id" || chr(31) || coalesce("code", '') || chr(31) || coalesce("invoice_key", '') || chr(31) || coalesce("invoice_number", '') || chr(31) || "recipient_name" || chr(31) || "city")`,
);

/** What joins the columns in the indexed text. */
const SEARCH_FIELD_SEPARATOR = String.fromCharCode(31);

/**
 * Above this many matches the term is not selective: the ILIKE path reads the
 * company once per query anyway, and a list of ids this long would cost more
 * than it saves. Measured at 1M deliveries: a selective term answers the id
 * read in 20–80 ms; a term in every row ("são paulo") reaches the cap in about
 * 200 ms and falls back.
 */
const SEARCH_PREFILTER_CAP = 1_000;

/** Trigrams need three characters; shorter terms keep the ILIKE path. */
const SEARCH_PREFILTER_MIN_LENGTH = 3;

type NarrowedDeliveryFilters = DeliveryListFilters & {
  /** The deliveries whose text the search matched; replaces `search` when present. */
  ids?: string[];
  /** The drivers the search matched by name or CNH; their deliveries also match. */
  matchedDriverIds?: string[];
};

/**
 * The filters with the search turned into the ids it matches, or unchanged
 * when the index cannot help (short term, a separator in it, or more matches
 * than the cap).
 */
async function narrowDeliverySearch(
  prisma: PrismaClient,
  filters: DeliveryListFilters,
): Promise<NarrowedDeliveryFilters> {
  const term = filters.search?.trim() ?? "";

  if ([...term].length < SEARCH_PREFILTER_MIN_LENGTH || term.includes(SEARCH_FIELD_SEPARATOR)) {
    return filters;
  }

  // The driver arms of the search: the company's drivers by name or CNH, a
  // small table. They stay OUT of the capped id read below: a driver piles up
  // more than the cap in a few weeks, so counting their deliveries there would
  // send every driver search back to the ILIKE path. The listing ORs them in
  // as `driverId IN (...)`, which the driverId index serves.
  const drivers = await prisma.driver.findMany({
    where: {
      businessId: filters.businessId,
      ...buildSearchOr<Prisma.DriverWhereInput>([
        { name: { contains: term, mode: "insensitive" } },
        { cnh: { contains: term, mode: "insensitive" } },
      ]),
    },
    select: { id: true },
  });

  const pattern = `%${escapeLikePattern(term)}%`;

  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "delivery"
    WHERE "businessId" = ${filters.businessId}
      ${filters.scopeDriverId ? Prisma.sql`AND "driverId" = ${filters.scopeDriverId}` : Prisma.empty}
      AND ${DELIVERY_SEARCH_TEXT} ILIKE ${pattern}
    LIMIT ${SEARCH_PREFILTER_CAP + 1}
  `;

  // Only the text matches are capped: a term common in the text columns is
  // not selective, whatever the drivers.
  if (rows.length > SEARCH_PREFILTER_CAP) return filters;

  return {
    ...filters,
    search: undefined,
    ids: rows.map((row) => row.id),
    matchedDriverIds: drivers.map((driver) => driver.id),
  };
}

export {
  DELIVERY_SEARCH_TEXT,
  SEARCH_FIELD_SEPARATOR,
  SEARCH_PREFILTER_CAP,
  SEARCH_PREFILTER_MIN_LENGTH,
  narrowDeliverySearch,
};
export type { NarrowedDeliveryFilters };
