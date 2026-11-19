import { describe, expect, it } from "vitest";

import {
  GEOCODER_PROVIDER,
  GEOCODING_SCOPES,
  MIRROR_TAKE,
  createGeocodingBudget,
} from "@/shared/delivery/geocoding/geocoding-budget";
import { GEOCODING_KEYS } from "@/shared/delivery/geocoding/geocoding-keys";
import { InMemoryProviderQuotaRepository } from "@/shared/services/provider-quota/in-memory-provider-quota-repository";
import type { IProviderQuotaRepository } from "@/shared/services/provider-quota/provider-quota-repository";

/**
 * The geocoder's daily budget (plan of 02/11/2026, E1; plano-escala F2-32):
 * the day lives in Postgres (provider_quota_day), one scope per path, and a
 * unit is taken before the call, only below the limit. It fails CLOSED — a
 * lookup put off costs a minute, a lookup over the quota costs money.
 *
 * During the rolling deploy the previous image still counts in the Redis
 * key: a take counts on from the greater of the row and the key, and
 * writes the key back as at least the row, so both images count one day;
 * an evicted key does not give the day back.
 */
const NOW = new Date("2026-11-03T15:00:00.000Z");
const DAY = "2026-11-03";
const KEY = GEOCODING_KEYS.budget(NOW);

/** The previous image's Redis: GET and the mirror's script. */
function legacyRedis(failing = false) {
  const values = new Map<string, number>();
  const ttls = new Map<string, number>();

  return {
    values,
    ttls,
    redis: {
      async get(key: string) {
        if (failing) throw new Error("ECONNREFUSED");

        return values.has(key) ? String(values.get(key)) : null;
      },
      async eval(
        script: string,
        _keys: number,
        key: string,
        ...argv: unknown[]
      ) {
        if (failing) throw new Error("ECONNREFUSED");
        if (script !== MIRROR_TAKE) throw new Error("unexpected script");

        const [floor, window] = argv.map(Number);
        const count = Math.max((values.get(key) ?? 0) + 1, floor);

        values.set(key, count);
        if (!ttls.has(key)) ttls.set(key, window);

        return count;
      },
    },
  };
}

function budget(
  limit: number,
  {
    quota = new InMemoryProviderQuotaRepository(),
    legacy,
    errors = [],
  }: {
    quota?: IProviderQuotaRepository;
    legacy?: ReturnType<typeof legacyRedis>;
    errors?: unknown[];
  } = {},
) {
  return createGeocodingBudget({
    quota,
    scope: GEOCODING_SCOPES.job,
    limit: () => limit,
    legacy: legacy && {
      redis: legacy.redis as never,
      key: GEOCODING_KEYS.budget,
    },
    onError: (err) => errors.push(err),
  });
}

describe("the geocoding budget", () => {
  it("takes the day's lookups one by one up to the limit, in the job's scope", async () => {
    const quota = new InMemoryProviderQuotaRepository();
    const job = budget(3, { quota });

    expect(await job.remaining(NOW)).toBe(3);
    expect(await job.take(NOW)).toBe(true);
    expect(await job.take(NOW)).toBe(true);
    expect(await job.remaining(NOW)).toBe(1);
    expect(await job.take(NOW)).toBe(true);
    expect(await job.take(NOW)).toBe(false);
    expect(await job.remaining(NOW)).toBe(0);
    expect(
      await quota.used(GEOCODER_PROVIDER, DAY, [GEOCODING_SCOPES.job]),
    ).toEqual({ "geocoding-job": 3 });
  });

  it("starts again on the next UTC day", async () => {
    const job = budget(1);

    expect(await job.take(NOW)).toBe(true);
    expect(await job.remaining(NOW)).toBe(0);
    expect(await job.remaining(new Date("2026-11-04T00:00:01.000Z"))).toBe(1);
  });

  it("allows nothing when the day cannot be read or taken, or with a zero limit", async () => {
    const errors: unknown[] = [];
    const broken: IProviderQuotaRepository = {
      used: async () => {
        throw new Error("connection terminated");
      },
      take: async () => {
        throw new Error("connection terminated");
      },
      giveBack: async () => {
        throw new Error("connection terminated");
      },
    };
    const closed = budget(100, { quota: broken, errors });

    expect(await closed.remaining(NOW)).toBe(0);
    expect(await closed.take(NOW)).toBe(false);
    expect(errors).toHaveLength(2);

    expect(await budget(0).remaining(NOW)).toBe(0);
    expect(await budget(0).take(NOW)).toBe(false);
  });

  it("counts on from the previous image's key during the rolling deploy, and keeps the key in step", async () => {
    const quota = new InMemoryProviderQuotaRepository();
    const legacy = legacyRedis();

    // The old replicas spent 5 today, in Redis only.
    legacy.values.set(KEY, 5);

    const job = budget(10, { quota, legacy });

    expect(await job.remaining(NOW)).toBe(5);
    expect(await job.take(NOW)).toBe(true);
    expect(
      (await quota.used(GEOCODER_PROVIDER, DAY, [GEOCODING_SCOPES.job]))[
        "geocoding-job"
      ],
    ).toBe(6);
    // The old replicas read the new call too, and the window is armed.
    expect(legacy.values.get(KEY)).toBe(6);
    expect(legacy.ttls.get(KEY)).toBe(26 * 60 * 60);

    // An old replica spends one more, then the new one takes.
    legacy.values.set(KEY, 7);

    expect(await job.take(NOW)).toBe(true);
    expect(legacy.values.get(KEY)).toBe(8);
    expect(await job.remaining(NOW)).toBe(2);
  });

  it("does not give the day back when Redis loses the key", async () => {
    const quota = new InMemoryProviderQuotaRepository();
    const legacy = legacyRedis();
    const job = budget(3, { quota, legacy });

    expect(await job.take(NOW)).toBe(true);
    expect(await job.take(NOW)).toBe(true);

    legacy.values.clear();

    expect(await job.remaining(NOW)).toBe(1);
    expect(await job.take(NOW)).toBe(true);
    expect(await job.take(NOW)).toBe(false);
    // The key is written back as the row: the old replicas read 3 again.
    expect(legacy.values.get(KEY)).toBe(3);
  });

  it("refuses at once when the previous image's key already reached the limit", async () => {
    const legacy = legacyRedis();

    legacy.values.set(KEY, 3);

    expect(await budget(3, { legacy }).take(NOW)).toBe(false);
  });

  it("still counts in the row when the previous image's key cannot be read or written", async () => {
    const quota = new InMemoryProviderQuotaRepository();
    const job = budget(2, { quota, legacy: legacyRedis(true) });

    expect(await job.take(NOW)).toBe(true);
    expect(await job.remaining(NOW)).toBe(1);
    expect(await job.take(NOW)).toBe(true);
    expect(await job.take(NOW)).toBe(false);
  });
});
