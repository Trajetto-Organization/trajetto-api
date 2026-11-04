import Redis from "ioredis";

import { env } from "@/env";
import { redisClientOptions } from "@/config/redis-client-options";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";
import { attachRedisConnectionLog } from "@/shared/services/redis-connection-log";

import { proofLocationConfigFromEnv } from "@/shared/services/proof-location/proof-location-service";
import { geocodeAddress } from "@/shared/services/proof-location/address-geocoder";
import { DeliveryGeocodingRepository } from "@/shared/delivery/geocoding/geocoding-repository";
import { createRedisGeocodingBudget } from "@/shared/delivery/geocoding/geocoding-budget";
import { DeliveryGeocodingService } from "@/shared/delivery/geocoding/delivery-geocoding-service";

const log = logger.child({ component: "cron", job: "geocode-deliveries" });

/**
 * The address points of new deliveries (plan of 02/11/2026, E1; decision
 * D15): every minute, the newest open deliveries without a point are looked
 * up on the Nominatim-compatible provider (REVERSE_GEOCODER_*), within
 * DELIVERY_GEOCODING_DAILY_BUDGET lookups a day across every replica.
 *
 * One replica per minute (the scheduler's lease), and the claim is a
 * FOR UPDATE SKIP LOCKED pick that leases its rows, so a catch-up run or a
 * second replica never asks twice about the same address. Quiet: a run with
 * nothing to do is the normal case. Without a provider or with a zero budget
 * it does nothing at all — not even a Redis connection.
 */
const geocodeDeliveriesJob: CronJobDefinition = {
  name: "geocode-deliveries",
  schedule: "* * * * *",
  quiet: true,

  async handler() {
    const config = proofLocationConfigFromEnv().geocoder;

    if (!config.url || env.DELIVERY_GEOCODING_DAILY_BUDGET <= 0) return;

    const redis = new Redis(
      env.REDIS_URL,
      redisClientOptions("geocoding-budget"),
    );

    attachRedisConnectionLog(redis, "geocoding-budget");

    try {
      const result = await new DeliveryGeocodingService(
        new DeliveryGeocodingRepository(),
        (address) => geocodeAddress(address, config),
        createRedisGeocodingBudget(
          redis,
          env.DELIVERY_GEOCODING_DAILY_BUDGET,
          (err) =>
            log.warn(
              { err },
              "geocoding budget unreadable: lookups put off to the next run",
            ),
        ),
      ).runOnce();

      if (result.claimed > 0) {
        log.info(result, "delivery addresses geocoded");
      } else if (result.skipped === "BUDGET") {
        log.debug("geocoding budget spent for today");
      }
    } finally {
      await redis.quit().catch(() => redis.disconnect());
    }
  },
};

export { geocodeDeliveriesJob };
