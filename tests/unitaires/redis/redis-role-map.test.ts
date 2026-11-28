import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Which Redis each client talks to (plano-escala F5-01).
 *
 * The counters (rate limits, handshakes, tickets, the geocoder's budget,
 * the providers' rate bucket, the cache of /health) live on REDIS_URL;
 * the pub/sub (the Socket.IO adapter, the wake between processes, the
 * WhatsApp lane and the emitter) may get a Redis of its own, PUBSUB_REDIS_URL, by the trigger of
 * the plan's section 7. That split only holds while every pub/sub client
 * comes from src/shared/redis/pubsub-redis.ts: one built anywhere else on
 * REDIS_URL would keep subscribing to the old Redis after the switch, and
 * hear nothing — realtime or the wake broken in silence.
 *
 * So the map below is every `new Redis(` of the runtime, with the URL it
 * is given. A new client fails here until someone says which Redis it
 * belongs to; a subscription, the adapter's pair or the variable outside
 * the factory fails too.
 */

const ROOT = process.cwd();

/** File → the first argument of each `new Redis(` in it, in order. */
const CLIENT_MAP: Record<string, string[]> = {
  // Counters, on REDIS_URL.
  "src/http.ts": ["env.REDIS_URL"],
  "src/websocket.ts": ["env.REDIS_URL"],
  "src/shared/socket/socket-ticket.ts": ["env.REDIS_URL"],
  "src/shared/delivery/geocoding/geocoding-runtime.ts": ["env.REDIS_URL"],
  "src/shared/notifications/provider-rate-bucket.ts": ["env.REDIS_URL"],
  "infra/cache/redis-connection.ts": ["env.REDIS_URL"],

  // The adapter's pair, built from the URL the factory hands it.
  "src/shared/socket/adapter-redis.ts": ["url", "url"],

  // The emitter of a process without sockets (plano-escala U-07) and the
  // pub/sub's hints, on the pub/sub's Redis.
  "src/shared/redis/pubsub-redis.ts": [
    "pubsubRedisUrl()",
    "pubsubRedisUrl()",
    "pubsubRedisUrl()",
  ],
};

const FACTORY = "src/shared/redis/pubsub-redis.ts";

function sources(dir: string): string[] {
  return readdirSync(resolve(ROOT, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) return sources(path);

      return /\.ts$/.test(entry.name) ? [path] : [];
    },
  );
}

const files = [...sources("src"), ...sources("infra")]
  .map((path) => relative(ROOT, resolve(ROOT, path)).split("\\").join("/"))
  .filter((path) => !path.includes("node_modules"));

const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

describe("the Redis clients of the runtime", () => {
  it("are all in the map, each with its Redis", () => {
    const found: Record<string, string[]> = {};

    for (const path of files) {
      const args = [...read(path).matchAll(/new Redis\(\s*([^,]+?)\s*,/g)].map(
        (match) => match[1].trim(),
      );

      if (args.length > 0) found[path] = args;
    }

    expect(found).toEqual(CLIENT_MAP);
  });

  it("subscribe only through the factory", () => {
    const outside = files.filter(
      (path) =>
        path !== FACTORY &&
        /\.(p|s)?subscribe\(/.test(read(path)) &&
        // The adapter subscribes inside the library, on the client the
        // factory built for it.
        path !== "src/shared/socket/adapter-redis.ts",
    );

    expect(outside).toEqual([]);
  });

  it("build the adapter's pair only through the factory", () => {
    const callers = files.filter(
      (path) =>
        /createAdapterRedisClients\(/.test(read(path)) &&
        path !== "src/shared/socket/adapter-redis.ts",
    );

    expect(callers).toEqual([FACTORY]);
  });

  it("name PUBSUB_REDIS_URL only in the factory, the schema and the logger", () => {
    const naming = files.filter((path) => /PUBSUB_REDIS_URL/.test(read(path)));

    expect(naming.sort()).toEqual(
      [
        FACTORY,
        "src/schemas/env-schema/index.ts",
        "src/shared/logging/logger.ts",
      ].sort(),
    );
  });
});
