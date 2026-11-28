import { describe, expect, it } from "vitest";

import { poolSettingsFrom } from "@/shared/database/pool-config";
import {
  probeUrl,
  readinessDatabaseUrl,
} from "@/shared/health/readiness-probe";
import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

/**
 * The readiness probe on a pool of its own in PgBouncer (plano-escala
 * F4-37): READINESS_DATABASE_URL.
 *
 * The probe already has its own connection in the API (OBS-11), so a full
 * pool of the replica never takes it out of rotation. Behind PgBouncer
 * that is not enough: on DATABASE_URL, the probe's statement waits in the
 * same PgBouncer pool as every request, and when that pool is saturated
 * the probe answers "no" (query_wait_timeout), every replica leaves the
 * balancer together, and a slow minute becomes an outage. The image's
 * `<db>_probe` alias is a pool of 2 server connections apart; the probe
 * goes there when READINESS_DATABASE_URL names it, and still says "no"
 * when Postgres is down, since the alias reaches the same database.
 *
 * Unset (the default, and every deploy of today), DATABASE_URL, as before.
 * tests/E2E/infra/readiness-probe-pool.test.ts fills the real pool.
 */
const DIRECT =
  "postgresql://trajetto_http:secret@trajetto-postgres-staging:5432/trajetto?schema=public&connection_limit=6";
const PROBE =
  "postgresql://trajetto_http:secret@trajetto-pgbouncer-staging:6432/trajetto_probe?schema=public&connection_limit=1&connect_timeout=3&pgbouncer=true";

describe("readinessDatabaseUrl", () => {
  it("is READINESS_DATABASE_URL when set", () => {
    expect(
      readinessDatabaseUrl({
        DATABASE_URL: DIRECT,
        READINESS_DATABASE_URL: PROBE,
      }),
    ).toBe(PROBE);
  });

  it("is DATABASE_URL without it, empty or blank included, as before", () => {
    for (const value of [undefined, "", "  "]) {
      expect(
        readinessDatabaseUrl({
          DATABASE_URL: DIRECT,
          READINESS_DATABASE_URL: value,
        }),
      ).toBe(DIRECT);
    }
  });

  it("is empty with neither (a module import never throws)", () => {
    expect(readinessDatabaseUrl({})).toBe("");
  });
});

describe("the probe's pool on the PgBouncer alias", () => {
  const settings = poolSettingsFrom(probeUrl(PROBE));

  it("holds one connection, answers within Traefik's 5 s, on the alias", () => {
    const url = new URL(settings.connectionString);

    expect(settings.max).toBe(1);
    expect(settings.poolTimeoutMs).toBe(2_000);
    expect(settings.queryTimeoutMs).toBe(3_000);
    expect(url.pathname).toBe("/trajetto_probe");
    expect(url.port).toBe("6432");
  });

  it("carries TimeZone alone and is recycled within PgBouncer's rolling (F4-31)", () => {
    expect(new URL(settings.connectionString).searchParams.get("options")).toBe(
      "-c TimeZone=UTC",
    );
    expect(settings.maxLifetimeSeconds).toBe(60);
  });
});

describe("READINESS_DATABASE_URL in the environment", () => {
  const BASE = {
    NODE_ENV: "development",
    REDIS_URL: "redis://localhost:6379",
    HTTP_REQUEST: "http://localhost:3000",
    JWT_SECRET: "a".repeat(32),
    JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
    MASTER_USER_EMAIL: "master@example.com",
    MASTER_USER_INITIAL_PASSWORD: "x",
  };

  const parse = (overrides: Record<string, string>) =>
    envSchema.safeParse(definedEnv({ ...BASE, ...overrides }));

  it("is optional, empty included", () => {
    const parsed = parse({ READINESS_DATABASE_URL: "" });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.READINESS_DATABASE_URL).toBeUndefined();
  });

  it("takes the alias through PgBouncer, or a direct URL", () => {
    expect(parse({ READINESS_DATABASE_URL: PROBE }).success).toBe(true);
    expect(parse({ READINESS_DATABASE_URL: DIRECT }).success).toBe(true);
  });

  it("refuses what is not a postgres URL, and ceilings in a pooled one's options", () => {
    expect(parse({ READINESS_DATABASE_URL: "redis://x:6379" }).success).toBe(
      false,
    );
    expect(
      parse({
        READINESS_DATABASE_URL: `${PROBE}&options=${encodeURIComponent("-c statement_timeout=3000")}`,
      }).success,
    ).toBe(false);
  });
});
