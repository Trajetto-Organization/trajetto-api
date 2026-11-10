import Redis from "ioredis";

import { env } from "@/env";
import { redisClientOptions } from "@/config/redis-client-options";
import { logger } from "@/shared/logging/logger";
import { attachRedisConnectionLog } from "@/shared/services/redis-connection-log";
import { proofLocationConfigFromEnv } from "@/shared/services/proof-location/proof-location-service";
import { geocodeAddress } from "@/shared/services/proof-location/address-geocoder";

import { announceSettledLookups } from "./geocoding-announcer";
import { createRedisGeocodingBudget } from "./geocoding-budget";
import { createRedisGeocodingGate } from "./geocoding-gate";
import { DeliveryGeocodingRepository } from "./geocoding-repository";
import {
  DeliveryGeocodingService,
  type GeocodingRunResult,
} from "./delivery-geocoding-service";

/**
 * The geocoding as the process runs it: the minute's job
 * (jobs/cron/geocode-deliveries-job.ts) and the lookup after a commit
 * (geocode-soon.ts) build the same service on the same pieces — the real
 * repository, the provider of REVERSE_GEOCODER_*, the budget and the gate
 * on ONE Redis connection per process, opened on first use (never when the
 * lookup is off) and closed by the shutdown (shutdownDeliveryGeocoding).
 */
const log = logger.child({ component: "geocoding" });

let redis: Redis | null = null;

function geocodingRedis(): Redis {
  if (redis) return redis;

  redis = new Redis(env.REDIS_URL, redisClientOptions("geocoding-budget"));
  attachRedisConnectionLog(redis, "geocoding-budget");

  return redis;
}

function deliveryGeocodingService(): DeliveryGeocodingService {
  const config = proofLocationConfigFromEnv().geocoder;
  const client = geocodingRedis();
  const repository = new DeliveryGeocodingRepository();

  return new DeliveryGeocodingService({
    repository,
    geocode: (address, query) =>
      geocodeAddress(address, config, undefined, query),
    budget: createRedisGeocodingBudget(
      client,
      env.DELIVERY_GEOCODING_DAILY_BUDGET,
      (err) =>
        log.warn(
          { err },
          "geocoding budget unreadable: lookups put off to the next run",
        ),
    ),
    gate: createRedisGeocodingGate(client, {
      onError: (err) =>
        log.warn(
          { err },
          "geocoding gate unreadable: lookups put off to the next run",
        ),
    }),
    announce: (settled) => announceSettledLookups(repository, settled),
  });
}

/**
 * One line per run that did something, and the reason when it stopped
 * short. The HTTP statuses are the diagnosis: 401/403 a key, 404 a URL,
 * 429 the quota, null a provider that did not answer.
 */
function logGeocodingRun(
  source: "job" | "soon",
  result: GeocodingRunResult,
): void {
  if (result.claimed === 0) {
    if (result.skipped === "BUDGET") {
      log.debug({ source }, "geocoding budget spent for today");
    } else if (result.skipped === "PAUSED") {
      log.debug({ source }, "geocoding paused by the provider's last answer");
    }

    return;
  }

  const summary = {
    source,
    claimed: result.claimed,
    resolved: result.resolved,
    coarse: result.coarse,
    notFound: result.notFound,
    failed: result.failed,
    released: result.released,
    stoppedBy: result.stoppedBy ?? null,
    providerStatuses: result.providerStatuses,
  };

  if (result.stoppedBy === "REFUSED") {
    log.error(
      summary,
      "geocoding provider refused the request: check REVERSE_GEOCODER_URL and REVERSE_GEOCODER_KEY; lookups paused for 15 min",
    );
  } else if (result.stoppedBy === "RATE_LIMITED") {
    log.warn(summary, "geocoding provider rate-limited the lookups");
  } else if (result.stoppedBy === "FAILURES") {
    log.warn(summary, "geocoding provider failing: run stopped early");
  } else {
    log.info(summary, "delivery addresses geocoded");
  }
}

/** Closes the process's connection; the next use opens another. */
async function closeGeocodingRedis(): Promise<void> {
  const client = redis;

  redis = null;

  try {
    await client?.quit();
  } catch {
    client?.disconnect();
  }
}

export {
  closeGeocodingRedis,
  deliveryGeocodingService,
  geocodingRedis,
  logGeocodingRun,
};
