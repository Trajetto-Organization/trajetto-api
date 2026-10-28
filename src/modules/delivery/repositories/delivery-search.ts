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

/** A delivery id (uuid v7, stored lowercase). */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An NF-e access key. */
const NFE_KEY_SHAPE = /^\d{44}$/;

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

  if (
    [...term].length < SEARCH_PREFILTER_MIN_LENGTH ||
    term.includes(SEARCH_FIELD_SEPARATOR)
  ) {
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
      ${filters.createdFrom ? Prisma.sql`AND "created_at" >= ${filters.createdFrom}` : Prisma.empty}
      ${filters.createdTo ? Prisma.sql`AND "created_at" < ${filters.createdTo}` : Prisma.empty}
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

/**
 * Whether the term is EXACTLY a delivery's id, order code, NF-e key or NF
 * number in this company (and a driver token's scope), case-insensitively.
 *
 * Read through the same trigram index as the search: the ILIKE narrows to
 * the rows containing the term, the equalities keep the exact ones. A term
 * shorter than the index's three characters is never exact — a two-letter
 * order code would otherwise cost a scan of the company per request.
 */
async function hasExactDeliveryMatch(
  prisma: PrismaClient,
  filters: Pick<DeliveryListFilters, "businessId" | "scopeDriverId">,
  rawTerm: string,
): Promise<boolean> {
  const term = rawTerm.trim();

  if (
    [...term].length < SEARCH_PREFILTER_MIN_LENGTH ||
    term.includes(SEARCH_FIELD_SEPARATOR)
  ) {
    return false;
  }

  const lowered = term.toLowerCase();

  // The notification's link carries the id, and an NF-e key is 44 digits:
  // each has its own unique index, a lookup of well under a millisecond,
  // where the trigram read below costs ~25 ms for a 36-character term
  // (measured on 100k deliveries of one tenant). Not found there, the term
  // may still be an order code of that shape, so the general read follows.
  const scope = {
    businessId: filters.businessId,
    ...(filters.scopeDriverId && { driverId: filters.scopeDriverId }),
  };

  const byKey = UUID_SHAPE.test(term)
    ? { id: lowered }
    : NFE_KEY_SHAPE.test(term)
      ? { invoice_key: term }
      : null;

  if (
    byKey &&
    (await prisma.delivery.findFirst({
      where: { ...scope, ...byKey },
      select: { id: true },
    }))
  ) {
    return true;
  }

  const pattern = `%${escapeLikePattern(term)}%`;

  const rows = await prisma.$queryRaw<Array<{ found: number }>>`
    SELECT 1 AS "found"
    FROM "delivery"
    WHERE "businessId" = ${filters.businessId}
      ${filters.scopeDriverId ? Prisma.sql`AND "driverId" = ${filters.scopeDriverId}` : Prisma.empty}
      AND ${DELIVERY_SEARCH_TEXT} ILIKE ${pattern}
      AND (
        lower("id") = ${lowered}
        OR lower(coalesce("code", '')) = ${lowered}
        OR lower(coalesce("invoice_key", '')) = ${lowered}
        OR lower(coalesce("invoice_number", '')) = ${lowered}
      )
    LIMIT 1
  `;

  return rows.length > 0;
}

/**
 * The filters with the period dropped when the search names one delivery
 * exactly (meeting of 14/10/2026).
 *
 * The screen opens on today, and a notification's link is `?search=<id>`
 * (delivery-occurrence-policy): with the period applied, the delivery of last
 * week it points at would be "not found". An exact id, order code, NF-e key
 * or NF number is a question about THAT document, whatever its date; a
 * partial term ("padaria") still searches inside the period.
 */
async function resolveDeliveryPeriod<F extends DeliveryListFilters>(
  prisma: PrismaClient,
  filters: F,
): Promise<{ filters: F; periodApplied: boolean }> {
  const hasPeriod = Boolean(filters.createdFrom || filters.createdTo);
  const term = filters.search?.trim() ?? "";

  if (!hasPeriod || !term) return { filters, periodApplied: hasPeriod };

  if (!(await hasExactDeliveryMatch(prisma, filters, term))) {
    return { filters, periodApplied: true };
  }

  return {
    filters: { ...filters, createdFrom: undefined, createdTo: undefined },
    periodApplied: false,
  };
}

export {
  DELIVERY_SEARCH_TEXT,
  SEARCH_FIELD_SEPARATOR,
  SEARCH_PREFILTER_CAP,
  SEARCH_PREFILTER_MIN_LENGTH,
  hasExactDeliveryMatch,
  narrowDeliverySearch,
  resolveDeliveryPeriod,
};
export type { NarrowedDeliveryFilters };
