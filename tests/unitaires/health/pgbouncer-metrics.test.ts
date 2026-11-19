import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERT_THRESHOLDS,
  collectAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";
import {
  buildClusterSampleRow,
  readClusterReadings,
  withClusterReadings,
} from "@/shared/health/cluster-sample";
import {
  PGBOUNCER_STATS_COMMANDS,
  readLatestPgBouncerSample,
  readPgBouncerMetrics,
  type ConsoleConnection,
  type PgBouncerMetrics,
} from "@/shared/health/pgbouncer-metrics";
import { pgBouncerStatsConfig } from "@/shared/health/pgbouncer-stats-config";
import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

/**
 * PgBouncer's numbers on /health/metrics and in the alerts (plano-escala
 * F4-36), from fixtures shaped as PgBouncer 1.26's console answers them
 * (the real one is read in tests/E2E/infra/pgbouncer-stats.test.ts).
 *
 * Behind PgBouncer, what fills first under load is its pool, not the
 * API's: clients waiting for a server connection are the 503s of
 * query_wait_timeout seconds later, and its server connections are the
 * budget. The API reads them by the stats login only: the admin one
 * (PAUSE, KILL, SHUTDOWN) is the owner's, never in an Application, so the
 * env check refuses any other login and the module sends SHOW alone. And
 * monitoring never takes anything down: unset, unreachable or refusing, it
 * answers null or `down`, never an exception.
 */
const STATS_URL =
  "postgresql://pgbouncer_stats:stats-secret-value@trajetto-pgbouncer-staging:6432/pgbouncer";

const POOLS = [
  {
    database: "pgbouncer",
    user: "pgbouncer",
    cl_active: 1,
    cl_waiting: 0,
    sv_active: 0,
    sv_idle: 0,
    sv_used: 0,
    maxwait: 0,
    maxwait_us: 0,
    pool_mode: "statement",
  },
  {
    database: "trajetto",
    user: "trajetto_http",
    cl_active: "12",
    cl_waiting: "2",
    sv_active: "20",
    sv_idle: "0",
    sv_used: "0",
    maxwait: "3",
    maxwait_us: "250000",
    pool_mode: "transaction",
  },
  {
    database: "trajetto_probe",
    user: "trajetto_http",
    cl_active: "2",
    cl_waiting: "0",
    sv_active: "0",
    sv_idle: "1",
    sv_used: "0",
    maxwait: "0",
    maxwait_us: "0",
    pool_mode: "transaction",
  },
];

const STATS = [
  {
    database: "pgbouncer",
    avg_xact_count: 0,
    avg_query_count: 0,
    avg_xact_time: 0,
    avg_query_time: 0,
    avg_wait_time: 0,
  },
  {
    database: "trajetto",
    avg_xact_count: "150",
    avg_query_count: "420",
    avg_xact_time: "6800",
    avg_query_time: "2100",
    avg_wait_time: "900",
  },
];

const DATABASES = [
  {
    name: "pgbouncer",
    pool_size: 2,
    max_connections: 0,
    current_connections: 0,
    paused: 0,
    disabled: 0,
  },
  {
    name: "trajetto",
    pool_size: "20",
    max_connections: "60",
    current_connections: "54",
    paused: "0",
    disabled: "0",
  },
  {
    name: "trajetto_probe",
    pool_size: "2",
    max_connections: "2",
    current_connections: "1",
    paused: "0",
    disabled: "0",
  },
];

const ANSWERS: Record<string, Array<Record<string, unknown>>> = {
  "SHOW POOLS": POOLS,
  "SHOW STATS": STATS,
  "SHOW DATABASES": DATABASES,
};

/**
 * A console as PgBouncer runs it for stats_users: SHOW answers, anything
 * else is "admin access needed". Records what it was sent, and to whom.
 */
function fakeConsole(
  options: {
    refuse?: Set<string>;
    sent?: Array<{ url: string; text: string }>;
  } = {},
) {
  const sent = options.sent ?? [];
  const ended: string[] = [];

  const connect = async (url: string): Promise<ConsoleConnection> => {
    const host = new URL(url).hostname;

    if (options.refuse?.has(host)) {
      throw Object.assign(new Error(`connect ECONNREFUSED ${host}:6432`), {
        code: "ECONNREFUSED",
      });
    }

    return {
      query: async (text) => {
        sent.push({ url, text });

        if (!/^SHOW /.test(text)) {
          throw Object.assign(new Error("admin access needed"), {
            code: "08P01",
            severity: "ERROR",
          });
        }

        return { rows: ANSWERS[text] ?? [] };
      },
      end: async () => {
        ended.push(url);
      },
    };
  };

  return { connect, sent, ended };
}

const NOW = new Date("2026-11-19T12:00:00Z");

describe("readPgBouncerMetrics", () => {
  it("reads nothing and answers null without PGBOUNCER_STATS_URL", async () => {
    const console = fakeConsole();

    expect(pgBouncerStatsConfig({})).toBeNull();
    expect(pgBouncerStatsConfig({ PGBOUNCER_STATS_URL: " " })).toBeNull();
    await expect(
      readPgBouncerMetrics(null, { connect: console.connect }),
    ).resolves.toBeNull();
    expect(console.sent).toEqual([]);
  });

  it("reads every task of tasks.<App Name>, by address, on the URL's port and login", async () => {
    const console = fakeConsole();
    const looked: string[] = [];

    const metrics = await readPgBouncerMetrics(
      pgBouncerStatsConfig({
        PGBOUNCER_STATS_URL: STATS_URL,
        PGBOUNCER_STATS_HOSTS: " tasks.trajetto-pgbouncer-staging , ",
      }),
      {
        lookup: async (host) => {
          looked.push(host);

          return ["10.0.1.7", "10.0.1.8"];
        },
        connect: console.connect,
        now: () => NOW,
      },
    );

    expect(looked).toEqual(["tasks.trajetto-pgbouncer-staging"]);
    expect(metrics?.status).toBe("up");
    expect(metrics?.instances.map((instance) => instance.address)).toEqual([
      "10.0.1.7",
      "10.0.1.8",
    ]);

    const urls = [...new Set(console.sent.map((entry) => entry.url))];

    expect(urls.map((url) => new URL(url).host)).toEqual([
      "10.0.1.7:6432",
      "10.0.1.8:6432",
    ]);
    for (const url of urls) {
      expect(new URL(url).username).toBe("pgbouncer_stats");
      expect(new URL(url).pathname).toBe("/pgbouncer");
    }
    // Every connection is closed after the read.
    expect(console.ended).toEqual(urls);
  });

  it("sends SHOW POOLS, SHOW STATS and SHOW DATABASES, and nothing else", async () => {
    const console = fakeConsole();

    await readPgBouncerMetrics(
      { url: STATS_URL, hosts: ["10.0.1.7"] },
      { connect: console.connect },
    );

    expect(console.sent.map((entry) => entry.text)).toEqual([
      "SHOW POOLS",
      "SHOW STATS",
      "SHOW DATABASES",
    ]);
    // The closed list: SHOW only, never PAUSE, RESUME, KILL or SHUTDOWN.
    expect(
      PGBOUNCER_STATS_COMMANDS.every((command) => /^SHOW /.test(command)),
    ).toBe(true);
  });

  it("answers the pools, traffic and server connections of the application's databases", async () => {
    const metrics = await readPgBouncerMetrics(
      { url: STATS_URL, hosts: ["10.0.1.7"] },
      { connect: fakeConsole().connect, now: () => NOW },
    );

    expect(metrics).toMatchObject({
      status: "up",
      read_at: NOW.toISOString(),
      error: null,
      totals: {
        instances: 1,
        instances_up: 1,
        cl_active: 14,
        cl_waiting: 2,
        maxwait_seconds: 3.25,
        maxwait_pool: "trajetto/trajetto_http",
        server_connections: 55,
        server_usage_percent: 90,
        server_usage_database: "trajetto",
        paused_databases: 0,
      },
    });

    const [instance] = metrics!.instances;

    // The console's own database is not the application's.
    expect(instance.pools.map((pool) => pool.database)).toEqual([
      "trajetto",
      "trajetto_probe",
    ]);
    expect(instance.pools[0]).toEqual({
      database: "trajetto",
      user: "trajetto_http",
      cl_active: 12,
      cl_waiting: 2,
      sv_active: 20,
      sv_idle: 0,
      sv_used: 0,
      maxwait_seconds: 3.25,
      pool_mode: "transaction",
    });
    expect(instance.stats).toEqual([
      {
        database: "trajetto",
        xact_per_second: 150,
        query_per_second: 420,
        avg_xact_time_us: 6800,
        avg_query_time_us: 2100,
        avg_wait_time_us: 900,
      },
    ]);
    expect(instance.databases[0]).toEqual({
      name: "trajetto",
      pool_size: 20,
      max_connections: 60,
      current_connections: 54,
      paused: false,
      disabled: false,
    });
  });

  it("is partial when a task does not answer, with the reason and never the URL", async () => {
    const metrics = await readPgBouncerMetrics(
      { url: STATS_URL, hosts: ["10.0.1.7", "10.0.1.8"] },
      { connect: fakeConsole({ refuse: new Set(["10.0.1.8"]) }).connect },
    );

    expect(metrics?.status).toBe("partial");
    expect(metrics?.instances[1]).toMatchObject({
      address: "10.0.1.8",
      status: "down",
      error: "ECONNREFUSED",
      pools: [],
    });
    // The silent task adds nothing to the totals.
    expect(metrics?.totals.instances_up).toBe(1);
    expect(JSON.stringify(metrics)).not.toContain("stats-secret-value");
  });

  it("is down, never an exception, when the name resolves to nothing", async () => {
    const metrics = await readPgBouncerMetrics(
      { url: STATS_URL, hosts: ["tasks.trajetto-pgbouncer-staging"] },
      {
        lookup: async () => {
          throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
            code: "ENOTFOUND",
          });
        },
        connect: fakeConsole().connect,
      },
    );

    expect(metrics).toMatchObject({
      status: "down",
      error: "ENOTFOUND",
      instances: [],
    });
  });

  it("reads the URL's own host when PGBOUNCER_STATS_HOSTS is unset", async () => {
    const looked: string[] = [];

    await readPgBouncerMetrics(
      pgBouncerStatsConfig({ PGBOUNCER_STATS_URL: STATS_URL }),
      {
        lookup: async (host) => {
          looked.push(host);

          return ["10.0.0.5"];
        },
        connect: fakeConsole().connect,
      },
    );

    expect(looked).toEqual(["trajetto-pgbouncer-staging"]);
  });

  it("names PgBouncer's refusal as the reason when a command is refused", async () => {
    // A console that refuses even SHOW: the reason is PgBouncer's words.
    const refusing = async (): Promise<ConsoleConnection> => ({
      query: async () => {
        throw Object.assign(new Error("admin access needed"), {
          code: "08P01",
        });
      },
      end: async () => {},
    });

    const metrics = await readPgBouncerMetrics(
      { url: STATS_URL, hosts: ["10.0.1.7"] },
      { connect: refusing },
    );

    expect(metrics?.instances[0]).toMatchObject({
      status: "down",
      error: "admin access needed",
    });
  });
});

/**
 * A PAUSE sent with the stats login is refused by PgBouncer ("admin access
 * needed", proved on the real one in the infra phase); this pins that the
 * API cannot even be given a login that could: the env check refuses any
 * login but pgbouncer_stats, and any database but the console.
 */
describe("PGBOUNCER_STATS_URL and PGBOUNCER_STATS_HOSTS in the environment", () => {
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

  it("are optional, empty included", () => {
    const parsed = parse({
      PGBOUNCER_STATS_URL: "",
      PGBOUNCER_STATS_HOSTS: "",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.PGBOUNCER_STATS_URL).toBeUndefined();
    expect(parsed.data?.PGBOUNCER_STATS_HOSTS).toBeUndefined();
  });

  it("take the stats login on the console, and tasks.<App Name>", () => {
    expect(
      parse({
        PGBOUNCER_STATS_URL: STATS_URL,
        PGBOUNCER_STATS_HOSTS: "tasks.trajetto-pgbouncer-staging",
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      "the admin login",
      STATS_URL.replace("pgbouncer_stats", "pgbouncer_admin"),
    ],
    ["the auth login", STATS_URL.replace("pgbouncer_stats", "pgbouncer_auth")],
    ["a runtime login", STATS_URL.replace("pgbouncer_stats", "trajetto_http")],
    ["the application database", STATS_URL.replace("/pgbouncer", "/trajetto")],
    ["something that is not a URL", "pgbouncer_stats"],
  ])("refuse %s in the URL", (_name, url) => {
    expect(parse({ PGBOUNCER_STATS_URL: url }).success).toBe(false);
  });

  it("names the admin login's place in the refusal", () => {
    const parsed = parse({
      PGBOUNCER_STATS_URL: STATS_URL.replace(
        "pgbouncer_stats",
        "pgbouncer_admin",
      ),
    });

    expect(parsed.error?.issues[0]?.message).toMatch(
      /pgbouncer_stats.*administração.*dono/,
    );
  });

  it("refuse hosts that are not names", () => {
    expect(
      parse({ PGBOUNCER_STATS_HOSTS: "tasks.a, http://x:6432" }).success,
    ).toBe(false);
  });
});

function healthy(pgbouncer?: PgBouncerMetrics | null): OperationalSnapshot {
  return {
    now: NOW,
    outboxEligibleLagSec: null,
    deliveryEligibleLagSec: { internal: null, external: null },
    webhookDueLagSec: null,
    aiEligibleLagSec: null,
    deliveryFailures: [],
    aiCredentialFailures: 0,
    cronJobs: [],
    partitionRunwayOk: true,
    partitionRunwayDays: 7,
    stuckWorkers: [],
    connectionUsagePercent: 10,
    redisOk: true,
    collectionErrors: [],
    pgbouncer,
  };
}

function metricsWith(
  totals: Partial<PgBouncerMetrics["totals"]>,
  status: PgBouncerMetrics["status"] = "up",
): PgBouncerMetrics {
  return {
    status,
    read_at: NOW.toISOString(),
    error: null,
    instances: [],
    totals: {
      instances: 1,
      instances_up: 1,
      cl_active: 3,
      cl_waiting: 0,
      maxwait_seconds: 0,
      maxwait_pool: null,
      server_connections: 5,
      server_usage_percent: 8.3,
      server_usage_database: "trajetto",
      paused_databases: 0,
      ...totals,
    },
  };
}

const codes = (snapshot: OperationalSnapshot) =>
  collectAlerts(snapshot, DEFAULT_ALERT_THRESHOLDS).map((alert) => alert.code);

describe("the PgBouncer alerts", () => {
  it("judge nothing without PgBouncer, and nothing on a healthy one", () => {
    expect(codes(healthy())).toEqual([]);
    expect(codes(healthy(null))).toEqual([]);
    expect(codes(healthy(metricsWith({})))).toEqual([]);
  });

  it("page a client waiting 2 s or more for a server connection", () => {
    expect(
      codes(healthy(metricsWith({ maxwait_seconds: 1.9, cl_waiting: 1 }))),
    ).toEqual([]);

    const alerts = collectAlerts(
      healthy(
        metricsWith({
          maxwait_seconds: 2,
          cl_waiting: 4,
          maxwait_pool: "trajetto/trajetto_http",
        }),
      ),
      DEFAULT_ALERT_THRESHOLDS,
    );

    expect(alerts).toEqual([
      {
        code: "pgbouncer-clients-waiting",
        message: expect.stringMatching(
          /há 2s no pool trajetto\/trajetto_http \(4 esperando/,
        ),
      },
    ]);
  });

  it("page a database at 80% of its server connections", () => {
    expect(codes(healthy(metricsWith({ server_usage_percent: 79.9 })))).toEqual(
      [],
    );
    expect(
      collectAlerts(
        healthy(metricsWith({ server_usage_percent: 80 })),
        DEFAULT_ALERT_THRESHOLDS,
      )[0],
    ).toEqual({
      code: "pgbouncer-server-saturation",
      message: expect.stringMatching(
        /80% das conexões de servidor do banco trajetto/,
      ),
    });
  });

  it("page a task that did not answer, naming it, and no address at all", () => {
    const partial: PgBouncerMetrics = {
      ...metricsWith({ instances: 2, instances_up: 1 }, "partial"),
      instances: [
        {
          address: "10.0.1.8",
          status: "down",
          error: "ECONNREFUSED",
          pools: [],
          databases: [],
          stats: [],
        },
      ],
    };

    expect(collectAlerts(healthy(partial), DEFAULT_ALERT_THRESHOLDS)).toEqual([
      {
        code: "pgbouncer-down",
        message: expect.stringMatching(
          /em 1 de 1 tarefa\(s\) \(10\.0\.1\.8: ECONNREFUSED\)/,
        ),
      },
    ]);

    expect(
      collectAlerts(
        healthy({
          ...metricsWith({ instances: 0, instances_up: 0 }, "down"),
          error: "ENOTFOUND",
        }),
        DEFAULT_ALERT_THRESHOLDS,
      )[0].message,
    ).toMatch(/sem endereço .*ENOTFOUND.*PGBOUNCER_STATS_HOSTS/);
  });
});

/**
 * Only the process with the cron reads the consoles, once a minute, in
 * the ops heartbeat: the readings feed the alerts and the cluster row,
 * which carries them to every replica's /health/metrics.
 */
describe("the cluster readings and row", () => {
  const SLOT = new Date("2026-11-19T12:01:00Z");
  const reading = metricsWith({ maxwait_seconds: 5, cl_waiting: 2 });

  const deps = {
    readDatabase: async () =>
      ({
        collection_errors: [],
        pg_wal: { bytes: null },
        archiver: null,
        parameters: null,
        xid_age: null,
        oldest_write_xact_seconds: null,
      }) as unknown as Parameters<typeof buildClusterSampleRow>[0]["database"],
    readRedis: async () =>
      ({
        status: "up",
        maxmemory_mb: 256,
        maxmemory_policy: "allkeys-lru",
        evicted_keys: 0,
      }) as unknown as Parameters<typeof buildClusterSampleRow>[0]["redis"],
    readBaseline: async () => null,
    readVolume: async () => null,
  };

  it("carry PgBouncer to the alerts, and never fail when its read throws", async () => {
    const readings = await readClusterReadings(SLOT, {
      ...deps,
      readPgBouncer: async () => reading,
    });

    expect(readings.pgbouncer).toBe(reading);
    expect(withClusterReadings(healthy(), readings).pgbouncer).toBe(reading);

    const failed = await readClusterReadings(SLOT, {
      ...deps,
      readPgBouncer: async () => {
        throw new Error("boom");
      },
    });

    expect(failed.pgbouncer).toBeNull();
    expect(withClusterReadings(healthy(), failed).pgbouncer).toBeUndefined();
  });

  it("write PgBouncer into the cluster row only when it was read", () => {
    const base = {
      slot: SLOT,
      identity: { role: "all" as const, replica: "api-1", commit: "abc1234" },
      snapshot: healthy(),
      database: {} as Parameters<typeof buildClusterSampleRow>[0]["database"],
      redis: {} as Parameters<typeof buildClusterSampleRow>[0]["redis"],
    };

    expect(
      buildClusterSampleRow({ ...base, pgbouncer: reading }).metrics.pgbouncer,
    ).toBe(reading);
    expect(buildClusterSampleRow(base).metrics).not.toHaveProperty("pgbouncer");
  });
});

describe("readLatestPgBouncerSample", () => {
  const reading = metricsWith({});

  it("answers the newest cluster row's reading with its minute", async () => {
    const sql: string[] = [];
    const client = {
      $queryRaw: async (query: { sql: string }) => {
        sql.push(query.sql);

        return [{ ts: new Date("2026-11-19T11:59:00Z"), pgbouncer: reading }];
      },
    } as unknown as Parameters<typeof readLatestPgBouncerSample>[0];

    await expect(readLatestPgBouncerSample(client, NOW)).resolves.toEqual({
      ...reading,
      sampled_at: "2026-11-19T11:59:00.000Z",
    });
    expect(sql[0]).toMatch(/role = 'cluster'/);
    expect(sql[0]).toMatch(/ORDER BY ts DESC\s+LIMIT 1/);
  });

  it("answers null without a reading, and on a failed read", async () => {
    const none = {
      $queryRaw: async () => [{ ts: NOW, pgbouncer: null }],
    } as unknown as Parameters<typeof readLatestPgBouncerSample>[0];
    const failing = {
      $queryRaw: async () => {
        throw new Error("relation does not exist");
      },
    } as unknown as Parameters<typeof readLatestPgBouncerSample>[0];
    const empty = {
      $queryRaw: async () => [],
    } as unknown as Parameters<typeof readLatestPgBouncerSample>[0];

    await expect(readLatestPgBouncerSample(none, NOW)).resolves.toBeNull();
    await expect(readLatestPgBouncerSample(failing, NOW)).resolves.toBeNull();
    await expect(readLatestPgBouncerSample(empty, NOW)).resolves.toBeNull();
  });
});
