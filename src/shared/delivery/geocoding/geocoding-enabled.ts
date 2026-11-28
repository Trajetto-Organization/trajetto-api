import { env } from "@/env";

/**
 * Whether delivery addresses are looked up at all (plan of 02/11/2026, E1):
 * a provider (REVERSE_GEOCODER_URL) and a daily budget above zero
 * (DELIVERY_GEOCODING_DAILY_BUDGET). The one answer the job, the lookup
 * after a commit (geocode-soon.ts) and the route read (address_lookup)
 * share, so the page never says "Localizando endereço…" on a server that
 * looks nothing up. Read at call time: the env is the process's, and the
 * tests switch it.
 */
function deliveryGeocodingEnabled(): boolean {
  return (
    Boolean(env.REVERSE_GEOCODER_URL) && env.DELIVERY_GEOCODING_DAILY_BUDGET > 0
  );
}

/** Why the lookup is off, for the job's one log line; null when on. */
function deliveryGeocodingOffReason(): string | null {
  if (!env.REVERSE_GEOCODER_URL) return "REVERSE_GEOCODER_URL is not set";

  if (env.DELIVERY_GEOCODING_DAILY_BUDGET <= 0) {
    return "DELIVERY_GEOCODING_DAILY_BUDGET is 0";
  }

  return null;
}

export { deliveryGeocodingEnabled, deliveryGeocodingOffReason };
