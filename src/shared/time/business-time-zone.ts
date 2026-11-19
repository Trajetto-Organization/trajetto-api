import { DEFAULT_BUSINESS_TIMEZONE, resolveTimeZone } from "./business-day";

import { remember, rememberRow } from "@/shared/http/request-context";

/**
 * Which zone a company's "today" is read in.
 *
 * Every business-day computation needs `Business.timezone`, and most use cases
 * already hold a business repository. The row type there does not declare the
 * column yet, so the value is read structurally: a row without it (or with an
 * unknown zone) falls back to the default, exactly like `resolveTimeZone`.
 */

interface BusinessLookup {
  findBusinessById: (businessId: string) => Promise<object | null>;
}

/** The column of a business row, read structurally; null without it. */
function storedZoneOf(business: object | null | undefined): string | null {
  const zone =
    business && "timezone" in business
      ? (business as { timezone?: unknown }).timezone
      : undefined;

  return typeof zone === "string" ? zone : null;
}

/** The zone a business row carries; the default for a missing row or value. */
function timeZoneOfBusiness(business: object | null | undefined): string {
  return resolveTimeZone(storedZoneOf(business));
}

/**
 * The request-memo key of a company's stored zone.
 *
 * One key for every reader of the zone, so a request asks the database for a
 * company's zone at most once, and the session lookup, which reads the
 * caller's own company in its one statement, leaves the answer under it.
 * Measured on the load mix (plano-escala F4-07): the zone was one more
 * statement on two thirds of the requests (the deliveries list, the tower,
 * the summary, the routes, the dashboard and the driver's work list), a row
 * the session had read a millisecond earlier.
 */
function businessZoneRequestKey(businessId: string): string {
  return `business-zone:${businessId}`;
}

/**
 * A company's STORED zone, `null` when there is no such company, read at
 * most once per request: `load` runs on the first ask, and not at all when
 * the session lookup already brought it.
 *
 * Per request, never per process (shared/http/request-context.ts): a zone
 * another request changes is what the next request reads, and a write to
 * the company in this request (BusinessRepository) forgets it. Outside a
 * request (workers, cron, scripts) `load` runs every time, as before.
 */
function storedBusinessZone(
  businessId: string,
  load: () => Promise<string | null>,
): Promise<string | null> {
  return remember(businessZoneRequestKey(businessId), load);
}

/**
 * Leaves in this request's memory the zone of a company it has just read
 * with the session's user. Nothing without a company or without the column.
 */
function rememberBusinessZone(
  businessId: string | null | undefined,
  business: { timezone?: string | null } | null | undefined,
): void {
  if (!businessId || typeof business?.timezone !== "string") return;

  rememberRow(businessZoneRequestKey(businessId), business.timezone);
}

/**
 * The company's zone, or the default when there is no single company (a
 * MASTER's global view reads the platform's default day). Once per request
 * (storedBusinessZone).
 */
async function loadBusinessTimeZone(
  businesses: BusinessLookup,
  businessId: string | null | undefined,
): Promise<string> {
  if (!businessId) return DEFAULT_BUSINESS_TIMEZONE;

  return resolveTimeZone(
    await storedBusinessZone(businessId, async () =>
      storedZoneOf(await businesses.findBusinessById(businessId)),
    ),
  );
}

export {
  businessZoneRequestKey,
  loadBusinessTimeZone,
  rememberBusinessZone,
  storedBusinessZone,
  timeZoneOfBusiness,
};
export type { BusinessLookup };
