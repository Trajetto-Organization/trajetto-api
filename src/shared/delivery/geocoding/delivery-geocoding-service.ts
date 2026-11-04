import type {
  GeocodableAddress,
  GeocodeOutcome,
} from "@/shared/services/proof-location/address-geocoder";

import type { GeocodingBudget } from "./geocoding-budget";
import type {
  GeocodingSettlement,
  IDeliveryGeocodingRepository,
} from "./geocoding-repository";

/**
 * One run of the geocoding job (plan of 02/11/2026, E1; decision D15): claim
 * the newest open deliveries without a point, ask the provider one at a
 * time within the day's budget, and settle each one:
 *
 * - ADDRESS or STREET: the point, geo_source GEOCODER, and the level;
 * - NEIGHBORHOOD or CITY: COARSE, with the level but no point — the geofence
 *   reads it as "não avaliável" and the map as "sem localização";
 * - NOT_FOUND: settled until the address changes;
 * - FAILED: tried again after the back-off, a few times.
 *
 * Off the request path entirely: a spreadsheet of a thousand rows imports
 * at the same speed as before and is geocoded over the following minutes.
 */

interface GeocodingRunOptions {
  /** Deliveries claimed per run (the cron runs every minute). */
  batchSize: number;
  /** Pause between two lookups, to stay under the provider's rate. */
  spacingMs: number;
}

interface GeocodingRunResult {
  claimed: number;
  resolved: number;
  coarse: number;
  notFound: number;
  failed: number;
  /** Why the run asked nothing, when it did not. */
  skipped?: "BUDGET";
}

type Geocode = (address: GeocodableAddress) => Promise<GeocodeOutcome>;

/** LocationIQ's free tier allows two per second; one every 600 ms is under it. */
const GEOCODING_RUN_DEFAULTS: GeocodingRunOptions = {
  batchSize: 20,
  spacingMs: 600,
};

function settlementOf(outcome: GeocodeOutcome): GeocodingSettlement {
  switch (outcome.kind) {
    case "FOUND":
      return outcome.precision === "ADDRESS" || outcome.precision === "STREET"
        ? {
            kind: "RESOLVED",
            latitude: outcome.latitude,
            longitude: outcome.longitude,
            precision: outcome.precision,
          }
        : { kind: "COARSE", precision: outcome.precision };
    case "NOT_FOUND":
      return { kind: "NOT_FOUND" };
    // DISABLED cannot reach here (the job does not run without a
    // provider); if it did, the address is simply tried again later.
    case "FAILED":
    case "DISABLED":
      return { kind: "FAILED" };
  }
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

class DeliveryGeocodingService {
  constructor(
    private readonly repository: IDeliveryGeocodingRepository,
    private readonly geocode: Geocode,
    private readonly budget: GeocodingBudget,
    private readonly options: GeocodingRunOptions = GEOCODING_RUN_DEFAULTS,
  ) {}

  async runOnce(now: Date = new Date()): Promise<GeocodingRunResult> {
    const result: GeocodingRunResult = {
      claimed: 0,
      resolved: 0,
      coarse: 0,
      notFound: 0,
      failed: 0,
    };

    // Claim only what the budget can still pay for: a claim stamps the
    // attempt, and a claimed row never asked would wait out a back-off for
    // nothing.
    const room = Math.min(
      this.options.batchSize,
      await this.budget.remaining(now),
    );

    if (room <= 0) return { ...result, skipped: "BUDGET" };

    const claims = await this.repository.claim(room, now);

    result.claimed = claims.length;

    for (const [index, claim] of claims.entries()) {
      if (index > 0 && this.options.spacingMs > 0) {
        await pause(this.options.spacingMs);
      }

      const outcome = await this.geocode(claim);

      await this.budget.spend(now);

      const settlement = settlementOf(outcome);

      await this.repository.settle(claim, settlement, now);

      if (settlement.kind === "RESOLVED") result.resolved += 1;
      else if (settlement.kind === "COARSE") result.coarse += 1;
      else if (settlement.kind === "NOT_FOUND") result.notFound += 1;
      else result.failed += 1;
    }

    return result;
  }
}

export { DeliveryGeocodingService, GEOCODING_RUN_DEFAULTS, settlementOf };
export type { GeocodingRunOptions, GeocodingRunResult };
