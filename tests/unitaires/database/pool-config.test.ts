import { describe, expect, it } from "vitest";

import {
  DatabaseUnavailableError,
  createPool,
} from "@/shared/database/pg-driver";
import {
  PRISMA_ONLY_PARAMETERS,
  poolSettingsFrom,
} from "@/shared/database/pool-config";
import { probeUrl } from "@/shared/health/readiness-probe";

import { fakePostgres } from "../../support/fake-postgres";
import { productionDatabaseUrl } from "../../support/production-database-url";

/**
 * DATABASE_URL's pool parameters, mapped onto the pg Pool behind Prisma 7's
 * driver adapter.
 *
 * pg reads none of Prisma 6's parameters: unmapped, the readiness probe would
 * hold ten connections instead of one, and a request finding the pool full
 * would wait forever instead of failing after pool_timeout. The URL typed in
 * Dokploy does not change; this pins what each of its parameters becomes.
 */
describe("the production runtime DATABASE_URL", () => {
  const settings = poolSettingsFrom(
    productionDatabaseUrl("DATABASE_URL").toString(),
  );

  it("keeps connection_limit as the pool size", () => {
    expect(settings.max).toBe(10);
  });

  it("fails a request that waits pool_timeout for a connection, instead of waiting forever", () => {
    expect(settings.poolTimeoutMs).toBe(20_000);
  });

  it("gives up on opening a connection after connect_timeout, inside pool_timeout (which bounds it too)", () => {
    expect(settings.connectTimeoutMs).toBe(5_000);
    expect(settings.connectTimeoutMs).toBeLessThan(settings.poolTimeoutMs);
  });

  it("bounds a query that never gets an answer by socket_timeout", () => {
    expect(settings.queryTimeoutMs).toBe(60_000);
  });

  it("closes a connection idle for max_idle_connection_lifetime", () => {
    expect(settings.idleTimeoutMs).toBe(300_000);
  });

  it("sends the statement, lock and idle-transaction ceilings to Postgres untouched", () => {
    const url = new URL(settings.connectionString);

    expect(url.searchParams.get("options")).toBe(
      "-c statement_timeout=30000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=60000",
    );
  });

  it("hands pg none of the parameters only Prisma 6 understood", () => {
    const url = new URL(settings.connectionString);

    for (const name of PRISMA_ONLY_PARAMETERS) {
      expect(url.searchParams.has(name), name).toBe(false);
    }
  });

  it("keeps the schema for the adapter", () => {
    expect(settings.schema).toBe("public");
  });
});

describe("the readiness probe's URL", () => {
  const settings = poolSettingsFrom(
    probeUrl(productionDatabaseUrl("DATABASE_URL").toString()),
  );

  it("holds ONE connection, not pg's default ten", () => {
    expect(settings.max).toBe(1);
  });

  it("answers well inside Traefik's 5 s", () => {
    expect(settings.poolTimeoutMs).toBe(2_000);
    expect(settings.connectTimeoutMs).toBe(3_000);
    expect(settings.queryTimeoutMs).toBe(3_000);
  });

  /**
   * pg-pool bounds the opening of a connection by pool_timeout as well, as
   * Prisma 6 did: the smaller of the two is the probe's connect.
   */
  it("gives up on a host that does not answer at pool_timeout's 2 s, not connect_timeout's 3 s", async () => {
    const silent = await fakePostgres({ kind: "silent" });
    const pool = createPool(poolSettingsFrom(probeUrl(silent.url)));

    try {
      const started = Date.now();
      const failure = await pool.query("SELECT 1").catch((error) => error);
      const elapsed = Date.now() - started;

      expect(failure).toBeInstanceOf(DatabaseUnavailableError);
      expect((failure as Error).message).toBe(
        "Connection terminated due to connection timeout",
      );
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(2_900);
    } finally {
      await pool.end();
      await silent.close();
    }
  });
});

describe("a URL without the parameters", () => {
  const settings = poolSettingsFrom("postgresql://u:p@db:5432/trajetto");

  it("keeps Prisma 6's timeouts, so nothing waits forever", () => {
    expect(settings.poolTimeoutMs).toBe(10_000);
    expect(settings.connectTimeoutMs).toBe(5_000);
    expect(settings.idleTimeoutMs).toBe(300_000);
  });

  it("uses pg's pool size and no client-side query timeout", () => {
    expect(settings.max).toBe(10);
    expect(settings.queryTimeoutMs).toBeUndefined();
  });

  it("reads 0 as 'no limit', as Prisma 6 did", () => {
    const unbounded = poolSettingsFrom(
      "postgresql://u:p@db:5432/d?socket_timeout=0&pool_timeout=0",
    );

    expect(unbounded.queryTimeoutMs).toBeUndefined();
    expect(unbounded.poolTimeoutMs).toBe(0);
  });
});

describe("a malformed parameter", () => {
  it("is refused with its name instead of becoming NaN", () => {
    expect(() =>
      poolSettingsFrom("postgresql://u:p@db:5432/d?pool_timeout=soon"),
    ).toThrow(/pool_timeout/);
    expect(() =>
      poolSettingsFrom("postgresql://u:p@db:5432/d?connection_limit=0"),
    ).toThrow(/connection_limit/);
  });

  it("an empty URL gives the defaults, so importing a module never throws", () => {
    expect(poolSettingsFrom(undefined).connectionString).toBe("");
  });
});
