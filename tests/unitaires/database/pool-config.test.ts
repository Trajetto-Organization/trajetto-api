import { describe, expect, it } from "vitest";

import {
  DatabaseUnavailableError,
  createPool,
} from "@/shared/database/pg-driver";
import {
  POOLED_MAX_CONNECTION_LIFETIME_SECONDS,
  PRISMA_ONLY_PARAMETERS,
  poolSettingsFrom,
  pooledUrlProblem,
  runtimeApplicationName,
} from "@/shared/database/pool-config";
import { processRoleFromEnvironment } from "@/shared/lifecycle/process-role";
import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";
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

  // 5 s since the load shedding (plano-escala F2-24); it was 20 s. A request
  // that finds the pool full gets its 503 with Retry-After at once instead of
  // holding the client while the queue behind it grows.
  it("fails a request that waits pool_timeout for a connection, instead of waiting forever", () => {
    expect(settings.poolTimeoutMs).toBe(5_000);
  });

  // Equal since pool_timeout went to 5 s: the opening gives up at the smaller
  // of the two, and either way within 5 s.
  it("gives up on opening a connection after connect_timeout, within pool_timeout (which bounds it too)", () => {
    expect(settings.connectTimeoutMs).toBe(5_000);
    expect(settings.connectTimeoutMs).toBeLessThanOrEqual(
      settings.poolTimeoutMs,
    );
  });

  it("bounds a query that never gets an answer by socket_timeout", () => {
    expect(settings.queryTimeoutMs).toBe(60_000);
  });

  it("closes a connection idle for max_idle_connection_lifetime", () => {
    expect(settings.idleTimeoutMs).toBe(300_000);
  });

  it("sends the statement, lock and idle-transaction ceilings to Postgres untouched, and the UTC session after them", () => {
    const url = new URL(settings.connectionString);

    expect(url.searchParams.get("options")).toBe(
      "-c statement_timeout=30000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=60000 -c TimeZone=UTC",
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

  it("runs its session in UTC, with the production ceilings, like the app's pool", () => {
    const url = new URL(settings.connectionString);

    expect(url.searchParams.get("options")).toBe(
      "-c statement_timeout=30000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=60000 -c TimeZone=UTC",
    );
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

/**
 * The queues and metrics compare `timestamp(3)` columns holding UTC with
 * now() in raw SQL, which is right only in a UTC session. The session zone is
 * asked for at startup, in `options`, so it no longer depends on the
 * server's, the database's or the role's default
 * (tests/E2E/database-session-timezone.test.ts proves it on Postgres).
 */
describe("the session's TimeZone", () => {
  function optionsOf(databaseUrl: string): string | null {
    const { connectionString } = poolSettingsFrom(databaseUrl);

    return new URL(connectionString).searchParams.get("options");
  }

  it("is UTC when the URL carries no options", () => {
    expect(optionsOf("postgresql://u:p@db:5432/trajetto")).toBe(
      "-c TimeZone=UTC",
    );
  });

  it("is UTC when the URL's options are empty", () => {
    expect(optionsOf("postgresql://u:p@db:5432/trajetto?options=")).toBe(
      "-c TimeZone=UTC",
    );
    expect(optionsOf("postgresql://u:p@db:5432/trajetto?options=%20")).toBe(
      "-c TimeZone=UTC",
    );
  });

  it("is appended to the URL's options, which keep their order and text", () => {
    expect(
      optionsOf(
        "postgresql://u:p@db:5432/trajetto?options=-c%20lock_timeout%3D5000%20-c%20search_path%3Dpublic",
      ),
    ).toBe("-c lock_timeout=5000 -c search_path=public -c TimeZone=UTC");
  });

  it("keeps the other parameters pg reads", () => {
    const url = new URL(
      poolSettingsFrom(
        "postgresql://u:p@db:5432/trajetto?sslmode=require&application_name=api&connection_limit=3",
      ).connectionString,
    );

    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("application_name")).toBe("api");
    expect(url.searchParams.get("options")).toBe("-c TimeZone=UTC");
  });

  /**
   * Postgres applies the last `-c` of a name, so appending UTC would silently
   * overrule a zone the URL asks for on purpose.
   */
  it.each([
    "-c TimeZone=America/Sao_Paulo",
    "-c timezone=America/Sao_Paulo",
    "-cTimeZone=America/Sao_Paulo",
    "--TimeZone=America/Sao_Paulo",
    "-c statement_timeout=30000 -c TIMEZONE=America/Sao_Paulo",
  ])("is left to the URL when its options set it (%j)", (options) => {
    expect(
      optionsOf(
        `postgresql://u:p@db:5432/trajetto?options=${encodeURIComponent(options)}`,
      ),
    ).toBe(options);
  });

  it("is not mistaken for timezone_abbreviations, or for a value that mentions it", () => {
    expect(
      optionsOf(
        `postgresql://u:p@db:5432/trajetto?options=${encodeURIComponent(
          "-c timezone_abbreviations=Default -c application_name=x--timezone=y",
        )}`,
      ),
    ).toBe(
      "-c timezone_abbreviations=Default -c application_name=x--timezone=y -c TimeZone=UTC",
    );
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

/**
 * The side pools' own statement ceilings (plano-escala F3-16): the read
 * bulkhead's 10 s and the batch pool's 30 min, on the runtime's URL until
 * each has a login of its own. Postgres applies the LAST `-c` of a name, so
 * the pool's ceiling goes after the URL's; and the URL's 60 s
 * socket_timeout would cut the batch pool's half-hour VACUUM at one
 * minute, so a ceiling above it raises the client's wait past it.
 */
describe("a side pool's statement ceiling", () => {
  const runtime = productionDatabaseUrl("DATABASE_URL").toString();

  it("goes after the URL's own statement_timeout, which it overrules", () => {
    const read = poolSettingsFrom(runtime, { statementTimeoutMs: 10_000 });

    expect(new URL(read.connectionString).searchParams.get("options")).toBe(
      "-c statement_timeout=30000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=60000 -c TimeZone=UTC -c statement_timeout=10000",
    );

    // Under the socket timeout: Postgres cancels first, the client waits.
    expect(read.queryTimeoutMs).toBe(60_000);
  });

  it("raises the client's wait past a ceiling longer than socket_timeout", () => {
    const batch = poolSettingsFrom(runtime, {
      statementTimeoutMs: 30 * 60_000,
    });

    expect(batch.queryTimeoutMs).toBe(30 * 60_000 + 30_000);
    expect(new URL(batch.connectionString).searchParams.get("options")).toMatch(
      / -c statement_timeout=1800000$/,
    );
  });

  it("leaves a URL with no options or no socket_timeout as the ceiling alone", () => {
    const bare = poolSettingsFrom(
      "postgresql://u:p@db.example.com:5432/app?schema=public",
      { statementTimeoutMs: 10_000 },
    );

    expect(new URL(bare.connectionString).searchParams.get("options")).toBe(
      "-c TimeZone=UTC -c statement_timeout=10000",
    );
    expect(bare.queryTimeoutMs).toBeUndefined();
  });

  it("changes nothing without a ceiling", () => {
    expect(poolSettingsFrom(runtime)).toEqual(
      poolSettingsFrom(runtime, undefined),
    );
  });
});

/**
 * The side pools' URLs in the environment (F3-16). The batch pool runs the
 * partition job's DETACH … CONCURRENTLY and session SET ROLE (F3-20), which
 * PgBouncer in transaction mode breaks in silence: a URL through it
 * refuses the boot instead. Empty is absent: both fall back to
 * DATABASE_URL.
 */
describe("the side pools' URLs in the environment", () => {
  const BASE = {
    NODE_ENV: "development",
    REDIS_URL: "redis://localhost:6379",
    HTTP_REQUEST: "http://localhost:3000",
    JWT_SECRET: "a".repeat(32),
    JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
    MASTER_USER_EMAIL: "master@example.com",
    MASTER_USER_INITIAL_PASSWORD: "x",
  };
  const DIRECT =
    "postgresql://trajetto_batch:secret@db.example.com:5432/app?schema=public";

  const parse = (overrides: Record<string, string>) =>
    envSchema.safeParse(definedEnv({ ...BASE, ...overrides }));

  it("are optional, empty included", () => {
    const parsed = parse({ DATABASE_READ_URL: "", BATCH_DATABASE_URL: "" });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.DATABASE_READ_URL).toBeUndefined();
    expect(parsed.data?.BATCH_DATABASE_URL).toBeUndefined();
  });

  it("take a direct postgres URL", () => {
    expect(
      parse({ DATABASE_READ_URL: DIRECT, BATCH_DATABASE_URL: DIRECT }).success,
    ).toBe(true);
  });

  it("refuse anything else, and a batch URL through PgBouncer", () => {
    expect(parse({ DATABASE_READ_URL: "redis://x:6379" }).success).toBe(false);
    expect(
      parse({ BATCH_DATABASE_URL: DIRECT.replace(":5432", ":6432") }).success,
    ).toBe(false);
    expect(
      parse({ BATCH_DATABASE_URL: `${DIRECT}&pgbouncer=true` }).success,
    ).toBe(false);
  });
});

/**
 * Which process and which pool a session is (plano-escala F3-02): with the
 * roles, pg_stat_activity has to tell the worker's connections from the
 * api's, and the bulkhead from the requests, or the connection budget per
 * role (ADR 0008) is a guess again.
 */
describe("the runtime pools' application_name", () => {
  it("is trajetto-<role>, with the side pool's or the probe's suffix", () => {
    expect(runtimeApplicationName("worker")).toBe("trajetto-worker");
    expect(runtimeApplicationName("api", "read")).toBe("trajetto-api-read");
    expect(runtimeApplicationName("all", "batch")).toBe("trajetto-all-batch");
    expect(runtimeApplicationName("api", "probe")).toBe("trajetto-api-probe");
  });

  it("takes the role from the process's own variables, legacy included", () => {
    expect(processRoleFromEnvironment({})).toBe("all");
    expect(processRoleFromEnvironment({ PROCESS_ROLE: "worker" })).toBe(
      "worker",
    );
    expect(processRoleFromEnvironment({ WORKERS_ENABLED: "false" })).toBe(
      "api",
    );
    expect(
      processRoleFromEnvironment({ PROCESS_ROLE: "", WORKERS_ENABLED: "" }),
    ).toBe("all");
  });

  it("leaves the default name to a role nobody knows (the boot refuses it)", () => {
    expect(processRoleFromEnvironment({ PROCESS_ROLE: "wroker" })).toBe(
      undefined,
    );
    expect(runtimeApplicationName(undefined, "read")).toBeUndefined();
  });

  it("is never read from the URL nor written into it", () => {
    const settings = poolSettingsFrom(
      "postgresql://u:p@db:5432/trajetto?connection_limit=3",
    );

    expect(settings.applicationName).toBeUndefined();
    expect(settings.connectionString).not.toContain("application_name");
  });
});

/**
 * A URL through PgBouncer (plano-escala F4-31): port 6432 or
 * pgbouncer=true. In transaction mode a setting either travels with every
 * client (PgBouncer tracks TimeZone) or belongs to the login (the runtime
 * roles carry the ceilings by ALTER ROLE): PgBouncer refuses a connection
 * whose options carry anything else, so such a URL would fail every query
 * of the process. And SIGTERM on PgBouncer waits for its clients to leave
 * within the 90 s Stop Grace Period, so its connections are recycled every
 * minute instead of the five of the idle lifetime.
 */
describe("a URL through PgBouncer (pooled)", () => {
  const POOLED =
    "postgresql://trajetto_http:secret@pgbouncer.example.com:6432/trajetto?schema=public&connection_limit=6&pool_timeout=5&connect_timeout=5&socket_timeout=60&pgbouncer=true";

  const withOptions = (base: string, options: string) =>
    `${base}&options=${encodeURIComponent(options)}`;

  it("carries TimeZone alone in its options, and no ceiling of a side pool", () => {
    const main = poolSettingsFrom(POOLED);
    const read = poolSettingsFrom(POOLED, { statementTimeoutMs: 10_000 });

    expect(new URL(main.connectionString).searchParams.get("options")).toBe(
      "-c TimeZone=UTC",
    );
    expect(new URL(read.connectionString).searchParams.get("options")).toBe(
      "-c TimeZone=UTC",
    );
    // The login's ceiling is the server's; the client's wait stays the URL's.
    expect(read.queryTimeoutMs).toBe(60_000);
    expect(
      poolSettingsFrom(POOLED, { statementTimeoutMs: 30 * 60_000 })
        .queryTimeoutMs,
    ).toBe(60_000);
  });

  it("is pooled by its port alone, or by pgbouncer=true on another port", () => {
    const byPort = poolSettingsFrom(POOLED.replace("&pgbouncer=true", ""), {
      statementTimeoutMs: 10_000,
    });
    const byFlag = poolSettingsFrom(POOLED.replace(":6432", ":5433"), {
      statementTimeoutMs: 10_000,
    });

    for (const settings of [byPort, byFlag]) {
      expect(
        new URL(settings.connectionString).searchParams.get("options"),
      ).toBe("-c TimeZone=UTC");
      expect(settings.maxLifetimeSeconds).toBe(60);
    }
  });

  it("retires its connections after 60 s, or sooner when the URL says so", () => {
    expect(POOLED_MAX_CONNECTION_LIFETIME_SECONDS).toBe(60);
    expect(poolSettingsFrom(POOLED).maxLifetimeSeconds).toBe(60);
    expect(
      poolSettingsFrom(`${POOLED}&max_connection_lifetime=30`)
        .maxLifetimeSeconds,
    ).toBe(30);
  });

  it("keeps a TimeZone the URL sets, and the rest of the pool settings", () => {
    const settings = poolSettingsFrom(
      withOptions(POOLED, "-c TimeZone=America/Sao_Paulo"),
    );
    const url = new URL(settings.connectionString);

    expect(url.searchParams.get("options")).toBe(
      "-c TimeZone=America/Sao_Paulo",
    );
    expect(url.searchParams.has("pgbouncer")).toBe(false);
    expect(settings.max).toBe(6);
    expect(settings.poolTimeoutMs).toBe(5_000);
  });

  it("passes the pool's application_name as a startup parameter, never in options", () => {
    const settings = poolSettingsFrom(POOLED);

    expect(settings.connectionString).not.toContain("application_name");
    expect(
      new URL(settings.connectionString).searchParams.get("options"),
    ).not.toMatch(/application_name/i);
  });

  it.each([
    "-c statement_timeout=30000",
    "-c TimeZone=UTC -c lock_timeout=5000",
    "-c idle_in_transaction_session_timeout=60000",
    "--statement_timeout=30000",
    "-cstatement_timeout=30000",
    "-c search_path=public",
    "-B 100",
  ])("is refused with options %j", (options) => {
    const url = withOptions(POOLED, options);

    expect(pooledUrlProblem(url)).toMatch(/só o TimeZone/);
    expect(() => poolSettingsFrom(url)).toThrow(/só o TimeZone/);
  });

  it("names what to take out of the options", () => {
    expect(
      pooledUrlProblem(
        withOptions(
          POOLED,
          "-c statement_timeout=30000 -c lock_timeout=5000 -c TimeZone=UTC",
        ),
      ),
    ).toMatch(/Tire do options: statement_timeout, lock_timeout$/);
  });

  it.each(["0", "61", "300", "soon"])(
    "is refused with max_connection_lifetime=%s",
    (value) => {
      const url = `${POOLED}&max_connection_lifetime=${value}`;

      expect(pooledUrlProblem(url)).toMatch(/max_connection_lifetime/);
      expect(() => poolSettingsFrom(url)).toThrow(/max_connection_lifetime/);
    },
  );

  it("changes nothing for a direct URL, ceilings in options included", () => {
    const direct = productionDatabaseUrl("DATABASE_URL").toString();

    expect(pooledUrlProblem(direct)).toBeNull();
    expect(poolSettingsFrom(direct).maxLifetimeSeconds).toBe(0);
    expect(
      new URL(
        poolSettingsFrom(direct, { statementTimeoutMs: 10_000 })
          .connectionString,
      ).searchParams.get("options"),
    ).toMatch(/ -c statement_timeout=10000$/);
  });

  it("takes an empty options", () => {
    expect(pooledUrlProblem(`${POOLED}&options=`)).toBeNull();
    expect(pooledUrlProblem(withOptions(POOLED, " "))).toBeNull();
  });
});

/**
 * The boot refuses a pooled URL that PgBouncer would refuse (F4-31): a
 * process that booted with one would fail every query instead, after the
 * rolling had already taken the old task away.
 */
describe("the runtime URLs through PgBouncer in the environment", () => {
  const BASE = {
    NODE_ENV: "development",
    REDIS_URL: "redis://localhost:6379",
    HTTP_REQUEST: "http://localhost:3000",
    JWT_SECRET: "a".repeat(32),
    JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
    MASTER_USER_EMAIL: "master@example.com",
    MASTER_USER_INITIAL_PASSWORD: "x",
  };
  const POOLED =
    "postgresql://trajetto_http:secret@pgbouncer.example.com:6432/trajetto?schema=public&connection_limit=6&pgbouncer=true";
  const CEILINGS = `options=${encodeURIComponent("-c statement_timeout=30000 -c lock_timeout=5000")}`;

  const parse = (overrides: Record<string, string>) =>
    envSchema.safeParse(definedEnv({ ...BASE, ...overrides }));

  const messagesOf = (overrides: Record<string, string>) => {
    const parsed = parse(overrides);

    return parsed.success
      ? []
      : parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        );
  };

  it("take a pooled URL with no options, or TimeZone alone", () => {
    expect(parse({ DATABASE_URL: POOLED }).success).toBe(true);
    expect(
      parse({
        DATABASE_URL: `${POOLED}&options=${encodeURIComponent("-c TimeZone=UTC")}`,
        DATABASE_READ_URL: POOLED,
      }).success,
    ).toBe(true);
  });

  it("refuse DATABASE_URL and DATABASE_READ_URL through PgBouncer with ceilings in options", () => {
    expect(messagesOf({ DATABASE_URL: `${POOLED}&${CEILINGS}` })).toEqual([
      expect.stringMatching(/^DATABASE_URL: .*só o TimeZone/),
    ]);
    expect(messagesOf({ DATABASE_READ_URL: `${POOLED}&${CEILINGS}` })).toEqual([
      expect.stringMatching(/^DATABASE_READ_URL: .*só o TimeZone/),
    ]);
  });

  it("refuse a pooled URL whose connections would outlive a rolling of PgBouncer", () => {
    expect(
      messagesOf({ DATABASE_URL: `${POOLED}&max_connection_lifetime=0` }),
    ).toEqual([
      expect.stringMatching(/^DATABASE_URL: max_connection_lifetime/),
    ]);
  });

  it("leave the direct URLs of today as they are, ceilings included", () => {
    expect(
      parse({
        DATABASE_URL: productionDatabaseUrl("DATABASE_URL").toString(),
        DATABASE_READ_URL: productionDatabaseUrl("DATABASE_URL").toString(),
      }).success,
    ).toBe(true);
    expect(parse({ DATABASE_URL: "" }).success).toBe(true);
  });
});
