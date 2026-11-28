import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LOAD_TIERS,
  PROD_COUNT_KEYS,
  SEED_TIERS_DIR,
  ZIPF_S,
  loadTierFromEnv,
  parseProdCounts,
  prodLikeTier,
  seedTierFiles,
  tierSettings,
  zipfShares,
} from "../../load/lib/load-tiers";

/**
 * The seed's tiers (plano-escala LOAD-02): the numbers of each rung, the
 * long tail, and the contract between the TypeScript that sets the counts
 * and the SQL that reads them.
 *
 * Why each case: a rung that drifts from the plan's ladder (seção 5) makes
 * every gate measured on it incomparable; a population of equal tenants
 * hides the plans a skewed one gets; a count the SQL reads and the runner
 * never sets fails mid-seed, and one the runner sets that no SQL reads is a
 * knob that does nothing; a random v4 id lands in no partition of the
 * tables partitioned by id; and the production counts must stay COUNTS,
 * read-only, so not a row of production's data ever reaches a seed.
 */
const sqlOf = (name: string) =>
  readFileSync(resolve(SEED_TIERS_DIR, name), "utf8");

const fullCounts = Object.fromEntries(
  PROD_COUNT_KEYS.map((key) => [key, 10]),
) as Record<(typeof PROD_COUNT_KEYS)[number], number>;

describe("the tiers", () => {
  it("follow the plan's ladder: 100k, 1m and 5m", () => {
    expect(LOAD_TIERS["100k"]).toMatchObject({
      tenants: 100,
      deliveries: 300_000,
      days: 180,
    });
    expect(LOAD_TIERS["1m"]).toMatchObject({
      tenants: 720,
      deliveries: 3_000_000,
    });
    expect(LOAD_TIERS["5m"]).toMatchObject({
      tenants: 3_600,
      deliveries: 15_000_000,
      trailDays: 30,
    });
  });

  it("keep 500 small companies with 150 thousand open stops on every rung of the ladder", () => {
    for (const tier of ["100k", "1m", "5m"] as const) {
      expect(LOAD_TIERS[tier], tier).toMatchObject({
        smallTenants: 500,
        openStops: 150_000,
      });
    }
  });

  it("keep their rows coherent: one activity and occurrence per delivery at most, queues settled", () => {
    for (const [name, tier] of Object.entries(LOAD_TIERS)) {
      expect(tier.activities, name).toBeLessThanOrEqual(tier.deliveries);
      expect(tier.occurrences, name).toBeLessThanOrEqual(tier.deliveries);
      expect(tier.activitiesV4, name).toBeLessThanOrEqual(tier.activities);
      expect(tier.webhookTenants, name).toBeLessThanOrEqual(tier.tenants);
      expect(tier.drivers, name).toBeGreaterThanOrEqual(tier.tenants);
      // Up to one notification delivery per channel per event (5).
      expect(tier.notificationDeliveries, name).toBeLessThanOrEqual(
        5 * tier.outboxEvents,
      );
    }
  });

  it("size the carriers by Zipf 1,1: a heavy head and a long tail", () => {
    expect(ZIPF_S).toBe(1.1);

    const shares = zipfShares(LOAD_TIERS["1m"].tenants);

    expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 10);
    expect(shares[0] / shares[1]).toBeCloseTo(2 ** 1.1, 10);

    for (let rank = 1; rank < shares.length; rank += 1) {
      expect(shares[rank]).toBeLessThan(shares[rank - 1]);
    }

    // The first carrier holds a large share; the last, a sliver of one.
    expect(shares[0]).toBeGreaterThan(0.1);
    expect(shares[shares.length - 1]).toBeLessThan(0.0005);
  });
});

describe("the tier's SQL", () => {
  const files = seedTierFiles();
  const sql = files.map((file) => readFileSync(file, "utf8")).join("\n");

  it("runs its numbered files in order, and never prod-counts.sql", () => {
    const names = files.map((file) => basename(file));

    expect(names).toEqual([...names].sort());
    expect(names[0]).toBe("00-setup.sql");
    expect(names).not.toContain("prod-counts.sql");

    // The secondary indexes go before the first bulk insert and come back
    // after the last one; the references are checked at the very end.
    const at = (name: string) => names.indexOf(name);

    expect(at("05-indexes-off.sql")).toBeLessThan(at("10-companies.sql"));
    expect(at("85-indexes-on.sql")).toBeGreaterThan(at("50-queues.sql"));
    expect(at("90-analyze.sql")).toBeGreaterThan(at("85-indexes-on.sql"));
    expect(names[names.length - 1]).toBe("95-references.sql");
  });

  it("drops only the non-unique indexes for the bulk load, and keeps their definitions to rebuild", () => {
    const off = sqlOf("05-indexes-off.sql");
    const on = sqlOf("85-indexes-on.sql");

    expect(off).toContain("NOT i.indisunique");
    expect(off).toContain("NOT i.indisprimary");
    expect(off).toContain("pg_get_indexdef(i.indexrelid)");
    // A real table, so the definitions outlive a session that died.
    expect(off).not.toMatch(/CREATE TEMP/i);
    expect(on).toContain("EXECUTE entry.definition");
    expect(on).toContain('DROP TABLE "load_seed_index"');
  });

  it("reads exactly the counts the runner sets", () => {
    const read = new Set(
      [
        ...sql.matchAll(/pg_temp\.load_n\('([a-z0-9_]+)'\)/g),
        ...sql.matchAll(/current_setting\('load\.([a-z0-9_]+)'\)/g),
      ].map((match) => match[1]),
    );
    const set = new Set(
      Object.keys(tierSettings(LOAD_TIERS.tiny)).map((name) =>
        name.replace(/^load\./, ""),
      ),
    );

    expect([...read].filter((name) => !set.has(name))).toEqual([]);
    expect([...set].filter((name) => !read.has(name))).toEqual([]);
  });

  it("mints uuid v7 ids, a v4 only for the activity lines that mirror production's", () => {
    const v4 = [...sql.matchAll(/gen_random_uuid\(\)/g)];

    expect(v4).toHaveLength(1);
    expect(sqlOf("20-deliveries.sql")).toMatch(
      /activities_v4'\)\s+THEN gen_random_uuid\(\)::text/,
    );
    expect(sql).toMatch(/'-7' \|\|/);
  });

  it("names the trail's day partitions as the partition job does", () => {
    expect(sqlOf("40-trail.sql")).toContain(
      "'driver_position_v2_' || to_char(day, 'YYYYMMDD')",
    );
  });
});

describe("prod-like", () => {
  it("is read by prod-counts.sql in a read-only transaction that prints only the known counts", () => {
    const query = sqlOf("prod-counts.sql");
    const code = query
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");

    expect(code).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(code).toMatch(/ROLLBACK;\s*$/);
    expect(code).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i,
    );

    const printed = [...code.matchAll(/^\s*'([a-z0-9_]+)',/gm)].map(
      (match) => match[1],
    );

    expect(printed.sort()).toEqual([...PROD_COUNT_KEYS].sort());
  });

  it("accepts only counts: an unknown key, a text or a negative number is refused", () => {
    expect(parseProdCounts(JSON.stringify(fullCounts))).toEqual(fullCounts);

    expect(() =>
      parseProdCounts(JSON.stringify({ ...fullCounts, email: 1 })),
    ).toThrow(/chaves desconhecidas: email/);
    expect(() =>
      parseProdCounts(JSON.stringify({ ...fullCounts, business: "120" })),
    ).toThrow(/business/);
    expect(() =>
      parseProdCounts(JSON.stringify({ ...fullCounts, delivery: -1 })),
    ).toThrow(/delivery/);
    expect(() =>
      parseProdCounts(JSON.stringify({ ...fullCounts, delivery: 1.5 })),
    ).toThrow(/delivery/);

    const { driver: _driver, ...missing } = fullCounts;

    expect(() => parseProdCounts(JSON.stringify(missing))).toThrow(/driver/);
    expect(() => parseProdCounts("[1, 2]")).toThrow();
    expect(() => parseProdCounts("not json")).toThrow();
  });

  it("turns production's counts into a tier of the same sizes, all carriers, no extra tail", () => {
    const tier = prodLikeTier({
      ...fullCounts,
      business: 120,
      driver: 900,
      delivery: 400_000,
      delivery_days: 300,
      delivery_event: 1_100_000,
      delivery_occurrence: 9_000,
      activity: 500_000,
      activity_v4: 350_000,
      route_stop_open: 4_000,
      driver_position: 3_600_000,
      driver_position_days: 90,
      domain_outbox_event: 800_000,
      notification_delivery: 1_000_000,
      notification: 300_000,
      webhook_delivery: 40_000,
      webhook_business: 6,
    });

    expect(tier).toMatchObject({
      tenants: 120,
      smallTenants: 0,
      deliveries: 400_000,
      days: 300,
      drivers: 900,
      events: 1_100_000,
      // One activity per delivery at most; the v4 share follows.
      activities: 400_000,
      activitiesV4: 350_000,
      occurrences: 9_000,
      openStops: 4_000,
      trailDays: 90,
      trailPoints: Math.round(3_600_000 / (900 * 90)),
      outboxEvents: 800_000,
      notificationDeliveries: 1_000_000,
      notifications: 300_000,
      webhookDeliveries: 40_000,
      webhookTenants: 6,
    });
  });
});

describe("loadTierFromEnv", () => {
  it("is null without LOAD_TIER: the seed does what it always did", () => {
    expect(loadTierFromEnv({})).toBeNull();
    expect(loadTierFromEnv({ LOAD_TIER: " " })).toBeNull();
  });

  it("names a preset, and refuses a tier it does not know", () => {
    expect(loadTierFromEnv({ LOAD_TIER: "1m" })).toEqual({
      name: "1m",
      counts: LOAD_TIERS["1m"],
    });
    expect(() => loadTierFromEnv({ LOAD_TIER: "10m" })).toThrow(/10m/);
  });

  it("asks prod-like for production's counts, inline or in a file", () => {
    expect(() => loadTierFromEnv({ LOAD_TIER: "prod-like" })).toThrow(
      /LOAD_PROD_COUNTS/,
    );

    const tier = loadTierFromEnv({
      LOAD_TIER: "prod-like",
      LOAD_PROD_COUNTS: JSON.stringify(fullCounts),
    });

    expect(tier?.name).toBe("prod-like");
    expect(tier?.counts.tenants).toBe(10);
  });
});

describe("tests/load/seed.ts", () => {
  it("guards the disposable database before it reads the tier, and runs the tier's SQL", () => {
    const source = readFileSync(
      resolve(__dirname, "../../load/seed.ts"),
      "utf8",
    );
    const main = source.slice(source.indexOf("async function main()"));

    expect(main.indexOf("assertDisposableDatabase(")).toBeGreaterThan(-1);
    expect(main.indexOf("assertDisposableDatabase(")).toBeLessThan(
      main.indexOf("loadTierFromEnv("),
    );
    expect(source).toContain("seedTierFiles()");
  });

  it("rebuilds the indexes when a file of the tier fails, before giving up", () => {
    const source = readFileSync(
      resolve(__dirname, "../../load/seed.ts"),
      "utf8",
    );

    expect(source).toMatch(/"85-indexes-on\.sql"/);
    expect(source).toMatch(
      /catch \(error\) \{\s+if \(indexesOn && file !== indexesOn\)/,
    );
  });
});
