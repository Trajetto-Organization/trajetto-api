import { afterAll, beforeAll, describe, expect, it } from "vitest";

import Redis from "ioredis";

import { redisClientOptions } from "@/config/redis-client-options";
import {
  GEOCODING_SCOPES,
  createGeocodingBudget,
} from "@/shared/delivery/geocoding/geocoding-budget";
import { createPrismaClient } from "@/shared/database/database-client";
import { InMemoryProviderQuotaRepository } from "@/shared/services/provider-quota/in-memory-provider-quota-repository";
import { ProviderQuotaRepository } from "@/shared/services/provider-quota/provider-quota-repository";

import {
  OTHER_PROVIDER,
  PROVIDER,
  providerQuotaContract,
  type ProviderQuotaHarness,
} from "../contract/repositories/provider-quota.contract";
import { KINDS, type Kind } from "../contract/support";
import { geocodingTestKeys } from "./support/geocoding-test-keys";

/**
 * Plano-escala F2-32 (decision D23): a provider's day per scope in
 * provider_quota_day, against Postgres and the twin, plus what only the
 * database can show — 50 takes at once with a limit of 10 grant exactly
 * 10, whichever connections they come on; takes of two scopes at once
 * never count one without the other nor deadlock; and the geocoder's day
 * does not come back when Redis loses the previous image's key.
 */
const prisma = createPrismaClient();
const memory = new InMemoryProviderQuotaRepository();

const harnesses: Record<Kind, () => ProviderQuotaHarness> = {
  prisma: () => ({
    kind: "prisma",
    repo: new ProviderQuotaRepository(prisma),
    async reset() {
      await prisma.providerQuotaDay.deleteMany({
        where: { provider: { in: [PROVIDER, OTHER_PROVIDER] } },
      });
    },
  }),
  "in-memory": () => ({
    kind: "in-memory",
    repo: memory,
    async reset() {
      memory.rows.clear();
    },
  }),
};

describe.each(KINDS)("provider quota day (%s)", (kind) => {
  providerQuotaContract(harnesses[kind]);
});

describe("provider quota day (prisma only)", () => {
  const DAY = "2026-11-16";
  let redis: Redis;
  const GEOCODING = geocodingTestKeys();

  beforeAll(async () => {
    redis = new Redis(
      process.env.REDIS_URL!,
      redisClientOptions("geocoding-budget"),
    );
  });

  afterAll(async () => {
    await GEOCODING.clear(redis);
    redis?.disconnect();
    await prisma.$disconnect();
  });

  it("grants exactly the limit to 50 takes at once, over several connections", async () => {
    await harnesses.prisma().reset();

    const clients = [prisma, createPrismaClient(), createPrismaClient()];

    try {
      const takes = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          new ProviderQuotaRepository(clients[index % clients.length]).take(
            PROVIDER,
            DAY,
            [{ scope: "geocoding-job", limit: 10 }],
          ),
        ),
      );

      const granted = takes.filter((take) => take.granted);

      expect(granted).toHaveLength(10);
      // Each grant saw its own count: 1 to 10, once each.
      expect(
        granted
          .map((take) => (take.granted ? take.used[0] : 0))
          .sort((a, b) => a - b),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(
        await new ProviderQuotaRepository(prisma).used(PROVIDER, DAY, [
          "geocoding-job",
        ]),
      ).toEqual({ "geocoding-job": 10 });
    } finally {
      await Promise.all(clients.slice(1).map((client) => client.$disconnect()));
    }
  });

  it("counts two scopes together under contention: never one without the other, never past either", async () => {
    await harnesses.prisma().reset();

    const repo = new ProviderQuotaRepository(prisma);
    const companies = ["a", "b", "c"].map(
      (letter) => `address-search:company-${letter}`,
    );

    // 60 searches of three companies at once: the platform's day is 12,
    // each company's 5.
    const takes = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        repo.take(PROVIDER, DAY, [
          { scope: "address-search", limit: 12 },
          { scope: companies[index % 3], limit: 5 },
        ]),
      ),
    );

    const used = await repo.used(PROVIDER, DAY, [
      "address-search",
      ...companies,
    ]);
    const companiesSum = companies.reduce((sum, scope) => sum + used[scope], 0);

    expect(takes.filter((take) => take.granted)).toHaveLength(12);
    expect(used["address-search"]).toBe(12);
    expect(companiesSum).toBe(12);

    for (const scope of companies) expect(used[scope]).toBeLessThanOrEqual(5);
  });

  it("does not give the geocoder's day back when Redis loses the previous image's key", async () => {
    await prisma.providerQuotaDay.deleteMany({
      where: { provider: "geocoder" },
    });

    const now = new Date("2026-11-16T15:00:00.000Z");
    const key = GEOCODING.keys.budget;
    const budget = createGeocodingBudget({
      quota: new ProviderQuotaRepository(prisma),
      scope: GEOCODING_SCOPES.job,
      limit: () => 5,
      legacy: { redis, key },
    });

    // The previous image spent 2 in Redis alone.
    await redis.set(key(now), "2");

    expect(await budget.take(now)).toBe(true);
    expect(await budget.take(now)).toBe(true);
    expect(await redis.get(key(now))).toBe("4");

    // The key is evicted: the row still holds the day.
    await redis.del(key(now));

    expect(await budget.remaining(now)).toBe(1);
    expect(await budget.take(now)).toBe(true);
    expect(await budget.take(now)).toBe(false);
    expect(await redis.get(key(now))).toBe("5");
    expect(
      (
        await prisma.providerQuotaDay.findFirst({
          where: { provider: "geocoder", scope: GEOCODING_SCOPES.job },
        })
      )?.used,
    ).toBe(5);
  });
});
