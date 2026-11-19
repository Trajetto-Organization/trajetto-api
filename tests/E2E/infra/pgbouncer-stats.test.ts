// @vitest-environment node
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { readPgBouncerMetrics } from "@/shared/health/pgbouncer-metrics";
import { pgBouncerStatsConfig } from "@/shared/health/pgbouncer-stats-config";

import { infraUrl } from "./support/infra-urls";

/**
 * PgBouncer's numbers as the process with the cron reads them, from the
 * real console, by the real stats login (plano-escala F4-36;
 * tests/E2E/infra/run.sh starts the image with PGBOUNCER_STATS_PASSWORD).
 *
 * The API holds only `pgbouncer_stats`: PgBouncer lets it run SHOW and
 * nothing else, so a PAUSE, a KILL or a SHUTDOWN sent with it is refused
 * ("admin access needed"), and the console stays the owner's.
 */
const POOLED = infraUrl("pgbouncer");
const STATS = infraUrl("pgbouncerStats");

const opened: pg.Client[] = [];

afterAll(async () => {
  await Promise.all(opened.map((client) => client.end().catch(() => {})));
});

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });

  client.on("error", () => {});
  await client.connect();
  opened.push(client);

  return client;
}

describe("the stats login of the real PgBouncer", () => {
  it("is refused PAUSE, RESUME, KILL, SHUTDOWN and RECONNECT", async () => {
    for (const command of [
      "PAUSE trajetto",
      "PAUSE",
      "RESUME trajetto",
      "KILL trajetto",
      "SHUTDOWN",
      "RECONNECT trajetto",
    ]) {
      const stats = await connect(STATS);
      const failure = await stats.query(command).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure, command).toBeInstanceOf(Error);
      expect((failure as Error).message, command).toMatch(
        /admin access needed/,
      );
    }

    // And the pool was never paused: a client still gets an answer.
    const client = await connect(POOLED);

    await expect(client.query("SELECT 1 AS ok")).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
  });

  it("reads the pools, the traffic and the server connections, through readPgBouncerMetrics", async () => {
    // A client with a transaction open: one active server connection in
    // the runtime's pool while the console is read.
    const holder = await connect(POOLED);

    await holder.query("BEGIN");
    await holder.query("SELECT 1");

    const metrics = await readPgBouncerMetrics(
      pgBouncerStatsConfig({ PGBOUNCER_STATS_URL: STATS }),
    );

    await holder.query("COMMIT");

    expect(metrics?.status).toBe("up");
    expect(metrics?.instances).toHaveLength(1);

    const [instance] = metrics!.instances;
    const pool = instance.pools.find(
      (entry) =>
        entry.database === "trajetto" && entry.user === "trajetto_http",
    );

    expect(pool).toMatchObject({ pool_mode: "transaction" });
    expect(pool!.sv_active).toBeGreaterThanOrEqual(1);
    expect(instance.databases.map((database) => database.name).sort()).toEqual([
      "trajetto",
      "trajetto_probe",
    ]);
    expect(
      instance.databases.find((database) => database.name === "trajetto"),
    ).toMatchObject({ max_connections: 60, paused: false, disabled: false });
    expect(
      instance.databases.find((database) => database.name === "trajetto_probe"),
    ).toMatchObject({ max_connections: 2 });
    expect(instance.stats.map((entry) => entry.database)).toContain("trajetto");
    // The console's own database is not counted as the application's.
    expect(instance.pools.some((entry) => entry.database === "pgbouncer")).toBe(
      false,
    );
    expect(metrics!.totals.server_connections).toBeGreaterThanOrEqual(1);
    expect(metrics!.totals.server_usage_database).not.toBeNull();
  });

  it("is a down instance, never an exception, with the wrong password", async () => {
    const wrong = new URL(STATS);

    wrong.password = "not-the-stats-password";

    const metrics = await readPgBouncerMetrics(
      pgBouncerStatsConfig({ PGBOUNCER_STATS_URL: wrong.toString() }),
    );

    expect(metrics?.status).toBe("down");
    expect(metrics?.instances[0]?.error).toMatch(/authentication failed/i);
    expect(JSON.stringify(metrics)).not.toContain("not-the-stats-password");
  });
});
