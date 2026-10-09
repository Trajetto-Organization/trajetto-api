import { DEFAULT_BUSINESS_TIMEZONE, resolveTimeZone } from "./business-day";

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

/** The zone a business row carries; the default for a missing row or value. */
function timeZoneOfBusiness(business: object | null | undefined): string {
  const zone =
    business && "timezone" in business
      ? (business as { timezone?: unknown }).timezone
      : undefined;

  return resolveTimeZone(typeof zone === "string" ? zone : null);
}

/**
 * The company's zone, or the default when there is no single company (a
 * MASTER's global view reads the platform's default day).
 */
async function loadBusinessTimeZone(
  businesses: BusinessLookup,
  businessId: string | null | undefined,
): Promise<string> {
  if (!businessId) return DEFAULT_BUSINESS_TIMEZONE;

  return timeZoneOfBusiness(await businesses.findBusinessById(businessId));
}

export { loadBusinessTimeZone, timeZoneOfBusiness };
export type { BusinessLookup };
