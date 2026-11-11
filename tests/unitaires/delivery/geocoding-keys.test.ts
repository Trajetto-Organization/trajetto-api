import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createRedisGeocodingBudget } from "@/shared/delivery/geocoding/geocoding-budget";
import { createRedisGeocodingGate } from "@/shared/delivery/geocoding/geocoding-gate";
import { createRedisGeocodingHold } from "@/shared/delivery/geocoding/geocoding-hold";
import {
  GEOCODING_KEYS,
  geocodingKeys,
  type GeocodingKeys,
} from "@/shared/delivery/geocoding/geocoding-keys";
import { createRedisAddressSearchStore } from "@/shared/services/address-search/address-search-limits";

/**
 * The geocoder's keys in Redis (ADR 0002, addendum of 10/11/2026). The
 * provider's second and minute, the pauses and the day's counts mean
 * something only when every replica — the old and the new during a rolling
 * deploy — reads and writes the same keys. The keys became injectable so
 * the E2E files could run the real gate on keys of their own (their Redis
 * outlives a run and can serve two at once: another run's call in the same
 * second answered a search 503 BUSY); these tests hold production to the
 * one shared namespace:
 *
 * - production's keys are the ones the replicas before the change use;
 * - every factory, given no keys, uses production's;
 * - one given another namespace touches nothing of production's;
 * - nothing in src names another namespace, nor spells a key by hand.
 */
const ROOT = resolve(__dirname, "..", "..", "..");
const NOW = new Date("2026-11-10T15:00:00.000Z");
const SECOND = Math.floor(NOW.getTime() / 1000);
const LATER = new Date(NOW.getTime() + 60_000);
const BUSINESS = "018fec3a-0000-7000-8000-000000000001";
const DIGEST = "a".repeat(64);

/** A Redis that knows nothing and records every key it is asked about. */
function recordingRedis() {
  const touched = new Set<string>();
  const touch = (...keys: unknown[]) => {
    for (const key of keys) touched.add(String(key));
  };

  return {
    touched,
    redis: {
      async get(key: string) {
        touch(key);
        return null;
      },
      async mget(...keys: string[]) {
        touch(...keys);
        return keys.map(() => null);
      },
      async set(key: string) {
        touch(key);
        return "OK";
      },
      async eval(_script: string, count: number, ...args: unknown[]) {
        touch(...args.slice(0, count));
        return 1;
      },
    },
  };
}

/** Every key the four factories reach, with `keys` or with their default. */
async function keysTouched(keys?: GeocodingKeys): Promise<string[]> {
  const { redis, touched } = recordingRedis();
  const gate = createRedisGeocodingGate(redis as never, {
    clock: () => NOW.getTime(),
    keys,
  });
  const budget = createRedisGeocodingBudget(
    redis as never,
    2_000,
    undefined,
    keys,
  );
  const hold = createRedisGeocodingHold(redis as never, () => 2_000, keys);
  const store = createRedisAddressSearchStore(redis as never, undefined, keys);

  await gate.paused(NOW);
  await gate.pause(LATER, NOW, "BURST");
  await gate.takeSlot();
  await budget.remaining(NOW);
  await budget.spend(NOW);
  await hold.held(NOW);
  await store.cached(BUSINESS, DIGEST);
  await store.remember(BUSINESS, DIGEST, { results: [], weak: false }, 60);
  await store.standing(BUSINESS, NOW);
  await store.spend(BUSINESS, NOW);
  await store.pauseSearch("REFUSED", LATER, NOW);

  return [...touched].sort();
}

/** The keys the replicas before the change use, spelled out. */
const SHARED = [
  `geocoding:deliveries:rate:${SECOND}`,
  "geocoding:provider:minute",
  "geocoding:deliveries:paused",
  "geocoding:deliveries:2026-11-10",
  "geocoding:search:paused",
  "geocoding:search:2026-11-10",
  `geocoding:search:2026-11-10:${BUSINESS}`,
  `geocoding:search:cache:${BUSINESS}:${DIGEST}`,
];

/** Text files under `dir`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(join(ROOT, path)).isDirectory()) return sources(path);

    return name.endsWith(".ts") ? [path.replace(/\\/g, "/")] : [];
  });
}

/** A file's lines that are code, not comments. */
function codeLines(path: string): string[] {
  return readFileSync(join(ROOT, path), "utf8")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line));
}

const KEYS_FILE = "src/shared/delivery/geocoding/geocoding-keys.ts";

describe("the geocoder's keys", () => {
  it("are, in production, the ones the replicas before the change use", () => {
    const keys = GEOCODING_KEYS;

    expect(
      [
        keys.second(SECOND),
        keys.minute,
        keys.pause,
        keys.budget(NOW),
        keys.searchPause,
        keys.searchDay(NOW),
        keys.searchBusinessDay(NOW, BUSINESS),
        keys.searchCache(BUSINESS, DIGEST),
      ].sort(),
    ).toEqual([...SHARED].sort());
  });

  it("are production's in every factory given none: the gate, the budget, the hold and the search", async () => {
    expect(await keysTouched()).toEqual([...SHARED].sort());
  });

  it("are another namespace's alone in every factory given one", async () => {
    const touched = await keysTouched(geocodingKeys("test:run-1:geocoding"));

    expect(touched).toHaveLength(SHARED.length);

    for (const key of touched) {
      expect(key.startsWith("test:run-1:geocoding:"), key).toBe(true);
      expect(SHARED).not.toContain(key);
    }
  });

  it("have one namespace in src, named once, and no key spelled by hand elsewhere", () => {
    const named: string[] = [];
    const spelled: string[] = [];

    for (const path of sources("src")) {
      const lines = codeLines(path);

      for (const line of lines) {
        if (
          /\bgeocodingKeys\(/.test(line) &&
          !/function geocodingKeys\(/.test(line)
        ) {
          named.push(`${path}: ${line.trim()}`);
        }

        if (path !== KEYS_FILE && /["'`]geocoding:/.test(line)) {
          spelled.push(`${path}: ${line.trim()}`);
        }
      }
    }

    expect(named).toEqual([
      `${KEYS_FILE}: const GEOCODING_KEYS = geocodingKeys("geocoding");`,
    ]);
    expect(spelled).toEqual([]);
  });

  it("are wired as production's: http.ts passes no keys to the search nor to the hold", () => {
    const http = codeLines("src/http.ts").join("\n");

    expect(http).toMatch(
      /configureGeocodingHold\(createRedisGeocodingHold\(rateLimitRedis\)\);/,
    );
    expect(http).toMatch(/configureAddressSearch\(rateLimitRedis\);/);
  });
});
