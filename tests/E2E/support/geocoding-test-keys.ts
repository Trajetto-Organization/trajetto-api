import Redis from "ioredis";
import { randomUUID } from "node:crypto";

import { redisClientOptions } from "@/config/redis-client-options";
import {
  geocodingKeys,
  type GeocodingKeys,
} from "@/shared/delivery/geocoding/geocoding-keys";

/**
 * The geocoder's keys of one E2E run (geocoding-keys.ts; docs/testes.md,
 * "O Redis é de todos os arquivos"). Production's are one namespace on
 * purpose — the provider's second and minute, the pauses and the day's
 * counts are the account's — and an E2E Redis outlives a run and can serve
 * two at once: two local runs, parallel replicas. A file that runs the
 * gate, reads the hold or spends the budget does so under a namespace of
 * its own, so another run never takes its slot, pauses it or counts in its
 * day, and clears it at the end (the search's cache lives 48 h otherwise).
 */
interface GeocodingTestKeys {
  keys: GeocodingKeys;
  /** Deletes every key of this run's namespace; never throws. */
  clear(redis: Pick<Redis, "keys" | "del"> | undefined): Promise<void>;
}

function geocodingTestKeys(): GeocodingTestKeys {
  const namespace = `test:${randomUUID()}:geocoding`;

  return {
    keys: geocodingKeys(namespace),

    async clear(redis) {
      const left = await redis?.keys(`${namespace}:*`).catch(() => []);

      if (left?.length) await redis?.del(...left).catch(() => undefined);
    },
  };
}

/**
 * A connection of the kind http.ts wires the search and the hold on — the
 * rate-limit one: fail-fast, no offline queue — open before it is used, as
 * a command sent before `ready` fails at once.
 */
async function readyRequestPathRedis(): Promise<Redis> {
  const redis = new Redis(
    process.env.REDIS_URL!,
    redisClientOptions("rate-limit"),
  );

  try {
    await new Promise<void>((settle, reject) => {
      redis.once("ready", settle);
      redis.once("error", reject);
    });
  } catch (err) {
    redis.disconnect();

    throw err;
  }

  return redis;
}

export { geocodingTestKeys, readyRequestPathRedis };
export type { GeocodingTestKeys };
