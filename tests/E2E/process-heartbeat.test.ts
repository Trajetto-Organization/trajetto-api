import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";
import { readDatabaseIdentity } from "@/shared/health/config-fingerprint";
import {
  deleteProcessHeartbeat,
  readLiveConsumers,
  readLiveSocketProcesses,
  startRuntimeProcessHeartbeat,
  writeProcessHeartbeat,
  type ProcessHeartbeatRow,
} from "@/shared/health/process-heartbeat";

/**
 * process_heartbeat against a real Postgres (plano-escala F3-03).
 *
 * What the unit file cannot reach: the UPSERT and its database clock, the
 * live window the wake counts consumers in, the row gone on stop, the
 * purge after 7 days, and the database's identity — the part of the
 * fingerprint that must be the same whatever URL reached the database
 * (another host, another login: PgBouncer comes one Application at a time
 * in wave 17, and each deploy in between must pass the check).
 */
const prisma = createPrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM "process_heartbeat"`;
});

function row(
  replica: string,
  overrides: Partial<ProcessHeartbeatRow> = {},
): ProcessHeartbeatRow {
  return {
    replica,
    role: "worker",
    app_env: "development",
    build_commit: "abc1234",
    config_fingerprint: "0123456789abcdef",
    node_hostname: null,
    queues: ["outbox", "internal", "external"],
    cron: true,
    sockets: false,
    started_at: new Date(),
    ...overrides,
  };
}

describe("a process's row", () => {
  it("is written once per replica, stamped with the database's clock, and rewritten in place", async () => {
    await writeProcessHeartbeat(row("worker-1"));
    await writeProcessHeartbeat(
      row("worker-1", { role: "api", queues: [], cron: false, sockets: true }),
    );

    const rows = await prisma.$queryRaw<
      Array<{
        replica: string;
        role: string;
        queues: string[];
        cron: boolean;
        sockets: boolean;
        fresh: boolean;
      }>
    >`
      SELECT "replica", "role", "queues", "cron", "sockets",
             "updated_at" > now() - interval '5 seconds' AS fresh
      FROM "process_heartbeat"
    `;

    expect(rows).toEqual([
      {
        replica: "worker-1",
        role: "api",
        queues: [],
        cron: false,
        sockets: true,
        fresh: true,
      },
    ]);
  });

  // The fleet's alert leaves out the realtime the deploy held on its build
  // by these two (plano-escala F3-31c): a beat that dropped them, or kept
  // a previous image's, would page or hide a role left behind.
  it("carries what its image says the realtime runs, and rewrites it", async () => {
    const source = "f".repeat(64);

    await writeProcessHeartbeat(
      row("realtime-1", {
        role: "realtime",
        realtime_source: source,
        contract_epoch: 9,
      }),
    );

    const read = () =>
      prisma.$queryRaw<
        Array<{ realtime_source: string | null; contract_epoch: number | null }>
      >`
        SELECT "realtime_source", "contract_epoch" FROM "process_heartbeat"
      `;

    expect(await read()).toEqual([
      { realtime_source: source, contract_epoch: 9 },
    ]);

    // The same replica on an image that does not say: nothing kept.
    await writeProcessHeartbeat(row("realtime-1", { role: "realtime" }));

    expect(await read()).toEqual([
      { realtime_source: null, contract_epoch: null },
    ]);
  });

  it("goes when the process stops", async () => {
    await writeProcessHeartbeat(row("worker-2"));
    await deleteProcessHeartbeat("worker-2");

    expect(
      await prisma.$queryRaw`SELECT 1 FROM "process_heartbeat"`,
    ).toHaveLength(0);
  });
});

describe("the live consumers", () => {
  it("count the processes that beat within 90 s, per queue", async () => {
    await writeProcessHeartbeat(row("worker-a"));
    await writeProcessHeartbeat(row("worker-b", { queues: ["external"] }));
    await writeProcessHeartbeat(row("api-a", { queues: [] }));
    await writeProcessHeartbeat(row("dead-worker"));

    // A process that died without its SIGTERM: its last beat is old.
    await prisma.$executeRaw`
      UPDATE "process_heartbeat"
      SET "updated_at" = now() - interval '2 minutes'
      WHERE "replica" = 'dead-worker'
    `;

    const live = await readLiveConsumers();

    expect(Object.fromEntries(live)).toEqual({
      outbox: 1,
      internal: 1,
      external: 2,
    });
  });
});

// The chat's presence compares them with the adapter's servers to find a
// replica that holds sockets and never beats presence: the image before
// U-05 during the rolling deploy that ships it (shared/socket/presence.ts).
// A count that included a worker, another environment or a dead process
// would hide that replica, and its drivers would read offline.
describe("the live socket processes", () => {
  it("count this environment's processes with sockets that beat within 90 s", async () => {
    const here = { app_env: env.APP_ENV, queues: [], cron: false };

    await writeProcessHeartbeat(row("api-a", { ...here, sockets: true }));
    await writeProcessHeartbeat(
      row("realtime-a", { ...here, role: "realtime", sockets: true }),
    );
    await writeProcessHeartbeat(row("worker-a", { app_env: env.APP_ENV }));
    await writeProcessHeartbeat(
      row("other-env", {
        ...here,
        app_env: `${env.APP_ENV}-other`,
        sockets: true,
      }),
    );
    await writeProcessHeartbeat(row("dead-api", { ...here, sockets: true }));

    await prisma.$executeRaw`
      UPDATE "process_heartbeat"
      SET "updated_at" = now() - interval '2 minutes'
      WHERE "replica" = 'dead-api'
    `;

    expect(await readLiveSocketProcesses()).toBe(2);
  });
});

describe("the runtime heartbeat", () => {
  it("writes this process with its fingerprint, and deletes it on stop", async () => {
    const heartbeat = startRuntimeProcessHeartbeat();

    try {
      // The first beat is at once; the fingerprint needs the database and
      // the Redis of this file to have answered.
      await vi.waitFor(
        async () => {
          const [written] = await prisma.$queryRaw<
            Array<{ role: string; fingerprint: string | null }>
          >`
            SELECT "role", "config_fingerprint" AS fingerprint
            FROM "process_heartbeat"
          `;

          expect(written).toMatchObject({
            role: "all",
            fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
          });
        },
        { timeout: 10_000, interval: 100 },
      );
    } finally {
      await heartbeat.stop();
    }

    expect(
      await prisma.$queryRaw`SELECT 1 FROM "process_heartbeat"`,
    ).toHaveLength(0);
  });
});

describe("the database's identity", () => {
  it("is the same through another host and another login", async () => {
    const url = new URL(process.env.DATABASE_URL as string);
    const login = `e2e_fp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    await prisma.$executeRawUnsafe(
      `CREATE ROLE ${login} LOGIN PASSWORD 'e2e-only'`,
    );
    await prisma.$executeRawUnsafe(
      `GRANT CONNECT ON DATABASE "${url.pathname.slice(1)}" TO ${login}`,
    );
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${login}`);
    await prisma.$executeRawUnsafe(
      `GRANT SELECT ON "cluster_epoch" TO ${login}`,
    );

    const otherHost = new URL(url);
    otherHost.hostname =
      url.hostname === "localhost" ? "127.0.0.1" : "localhost";

    const otherLogin = new URL(url);
    otherLogin.username = login;
    otherLogin.password = "e2e-only";

    const clients = [otherHost, otherLogin].map((target) =>
      createPrismaClient({}, { url: target.toString() }),
    );

    try {
      const [mine, ...theirs] = await Promise.all([
        readDatabaseIdentity(prisma),
        ...clients.map((client) => readDatabaseIdentity(client)),
      ]);

      expect(mine).toMatch(/^\d+\/.+$/);
      expect(theirs).toEqual([mine, mine]);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
      await prisma.$executeRawUnsafe(`DROP OWNED BY ${login}`);
      await prisma.$executeRawUnsafe(`DROP ROLE ${login}`);
    }
  });
});

describe("the purge", () => {
  it("takes the rows without a beat for 7 days and leaves the live ones", async () => {
    const { purgeOpsSeries } = await import("@/jobs/cron/purge-ops-series-job");

    await writeProcessHeartbeat(row("live"));
    await writeProcessHeartbeat(row("gone-for-a-week"));

    await prisma.$executeRaw`
      UPDATE "process_heartbeat"
      SET "updated_at" = ${new Date(Date.now() - 8 * DAY_MS)}
      WHERE "replica" = 'gone-for-a-week'
    `;

    const results = await purgeOpsSeries();

    expect(results.process_heartbeat.deleted).toBe(1);
    expect(
      await prisma.$queryRaw`SELECT "replica" FROM "process_heartbeat"`,
    ).toEqual([{ replica: "live" }]);
  });
});
