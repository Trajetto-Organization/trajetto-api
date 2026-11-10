import { GEOCODING_MAX_ATTEMPTS } from "./geocoding-rules";

/**
 * What the route page says about a stop without a point (owner's report of
 * 09/11/2026: a full address shown "Sem localização", as if nothing would
 * ever find it). Derived from the geocoder's bookkeeping, never stored:
 *
 * - SEARCHING: a lookup is under way or due within moments — the address
 *   was written (created or edited) or claimed less than
 *   LOOKUP_PENDING_MS ago, has not been answered, and the lookups are not
 *   held (geocoding-hold.ts: a refusal, the day's quota, the budget spent)
 *   ("Localizando endereço…");
 * - NOT_LOCATED: the lookup is over without a point — the provider knows no
 *   such address, only reached the district or the city, or every attempt
 *   was spent ("Endereço não localizado — fixe no mapa");
 * - null: nothing to promise — the stop has a point, the server looks
 *   nothing up, the delivery is closed (the job only takes PENDING and
 *   IN_TRANSIT), a dispatcher cleared a point the geocoder had found, the
 *   lookups are held, the last attempt failed and the next waits out its
 *   back-off, or nothing asked about the address lately ("Sem
 *   localização").
 *
 * SEARCHING never outlives its window (review of 09/11/2026): a provider
 * that refused every request, a quota spent or a queue that never came to
 * the delivery kept the spinner for good, and the dispatcher waited
 * instead of pinning. A point found later still reaches the page
 * (`routeStopsLocated`), whatever it said meanwhile.
 *
 * "Fixar no mapa" stays open in every case: the state only tells the
 * dispatcher whether waiting a moment is worth it.
 */
type AddressLookupState = "SEARCHING" | "NOT_LOCATED";

/** The delivery columns the state reads. */
interface AddressLookupSubject {
  status: string;
  latitude?: number | null;
  longitude?: number | null;
  geo_source?: string | null;
  geocode_status?: string | null;
  geocode_attempts?: number | null;

  /** The last write of the delivery: a create or an address edit asks. */
  updated_at?: Date | string | null;

  /** The last claim of its address, the job's or the one after a write. */
  geocode_attempted_at?: Date | string | null;
}

interface AddressLookupContext {
  /** Whether this server looks addresses up at all (geocoding-enabled.ts). */
  enabled: boolean;
  now: Date;

  /** Whether the lookups are held now (geocoding-hold.ts). */
  held?: boolean;
}

/**
 * How long after the last ask a lookup counts as under way: the lookup
 * after a write answers in seconds, the minute's job takes the open stops
 * first (claimOpenStops), and a claim answers in seconds too. Past this,
 * something kept the lookup from coming.
 */
const LOOKUP_PENDING_MS = 10 * 60_000;

/** The delivery statuses the geocoding job claims. */
const LOOKED_UP_STATUSES = new Set(["PENDING", "IN_TRANSIT"]);

function instantOf(value: Date | string | null | undefined): number | null {
  if (value == null) return null;

  const at = new Date(value).getTime();

  return Number.isFinite(at) ? at : null;
}

/** Whether the address was written or claimed within the window. */
function askedLately(delivery: AddressLookupSubject, now: Date): boolean {
  const asked = Math.max(
    instantOf(delivery.updated_at) ?? Number.NEGATIVE_INFINITY,
    instantOf(delivery.geocode_attempted_at) ?? Number.NEGATIVE_INFINITY,
  );

  return now.getTime() - asked < LOOKUP_PENDING_MS;
}

function addressLookupState(
  delivery: AddressLookupSubject,
  { enabled, now, held = false }: AddressLookupContext,
): AddressLookupState | null {
  if (delivery.latitude != null && delivery.longitude != null) return null;

  if (!enabled || delivery.geo_source != null) return null;

  if (!LOOKED_UP_STATUSES.has(delivery.status)) return null;

  // The claim's own cap: past it, no run takes the delivery again, with or
  // without a status (a claim whose replica died writes none).
  const spent = (delivery.geocode_attempts ?? 0) >= GEOCODING_MAX_ATTEMPTS;

  switch (delivery.geocode_status ?? null) {
    case null:
      if (spent) return "NOT_LOCATED";

      return !held && askedLately(delivery, now) ? "SEARCHING" : null;
    case "FAILED":
      // The provider failed, the address was not judged: the next attempt
      // waits out its back-off (15 min to 6 h), nothing comes in moments.
      return spent ? "NOT_LOCATED" : null;
    case "NOT_FOUND":
    case "COARSE":
      return "NOT_LOCATED";
    default:
      return null;
  }
}

export { LOOKUP_PENDING_MS, addressLookupState };
export type { AddressLookupContext, AddressLookupState, AddressLookupSubject };
