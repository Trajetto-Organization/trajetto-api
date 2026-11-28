// @vitest-environment node
import pg from "pg";
import type { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  READINESS_TIMEOUT_MS,
  createProbeClient,
  probeDatabase,
} from "@/shared/health/readiness-probe";

import { infraUrl } from "./support/infra-urls";

/**
 * The readiness probe on PgBouncer's `<db>_probe` alias, with the
 * requests' pool saturated, on the real PgBouncer (plano-escala F4-37;
 * tests/E2E/infra/run.sh starts it).
 *
 * Every server connection of the runtime's pool (trajetto/trajetto_http)
 * is held by an open transaction, as under a burst. A probe on that pool
 * waits behind them and answers "no" within its 3 s, which would take
 * every replica out of the balancer at once. The same probe on the alias,
 * READINESS_DATABASE_URL, has two server connections of its own and
 * answers "yes": the database is up, only busy.
 */
const POOLED = infraUrl("pgbouncer");
const STATS = infraUrl("pgbouncerStats");

/** Past the probe's 3 s twice, the stack's logins, with room. */
const TEST_TIMEOUT_MS = 60_000;

/** The pooled URL on another database of PgBouncer (F4-31's flag on). */
function pooledUrlOn(database: string): string {
  const url = new URL(POOLED);

  url.pathname = `/${database}`;
  url.searchParams.set("pgbouncer", "true");

  return url.toString();
}

const holders: pg.Client[] = [];
const probes: PrismaClient[] = [];

afterAll(async () => {
  await releaseThePool();
  await Promise.all(probes.map((probe) => probe.$disconnect()));
});

async function defaultPoolSize(): Promise<number> {
  const stats = new pg.Client({ connectionString: STATS });

  await stats.connect();

  try {
    const { rows } = await stats.query<{ key: string; value: string }>(
      "SHOW CONFIG",
    );

    return Number(rows.find((row) => row.key === "default_pool_size")?.value);
  } finally {
    await stats.end();
  }
}

async function fillThePool(): Promise<void> {
  const size = await defaultPoolSize();

  expect(size).toBeGreaterThan(0);

  for (let index = 0; index < size; index += 1) {
    const holder = new pg.Client({ connectionString: POOLED });

    holder.on("error", () => {});
    await holder.connect();
    holders.push(holder);
    await holder.query("BEGIN");
    await holder.query("SELECT 1");
  }
}

async function releaseThePool(): Promise<void> {
  for (const holder of holders.splice(0)) {
    await holder.query("COMMIT").catch(() => {});
    await holder.end().catch(() => {});
  }
}

function probeOn(database: string): PrismaClient {
  const probe = createProbeClient(pooledUrlOn(database));

  probes.push(probe);

  return probe;
}

describe("readiness with the requests' pool in PgBouncer saturated", () => {
  it(
    "answers ready on the probe alias, and would not on the requests' pool",
    async () => {
      const onAlias = probeOn("trajetto_probe");
      const onMain = probeOn("trajetto");

      // Both logged in and answering before the burst.
      await expect(probeDatabase(READINESS_TIMEOUT_MS, onAlias)).resolves.toBe(
        true,
      );
      await expect(probeDatabase(READINESS_TIMEOUT_MS, onMain)).resolves.toBe(
        true,
      );

      await fillThePool();

      // The alias: its own server connections, a "yes" well inside 3 s.
      const started = Date.now();

      await expect(probeDatabase(READINESS_TIMEOUT_MS, onAlias)).resolves.toBe(
        true,
      );
      expect(Date.now() - started).toBeLessThan(READINESS_TIMEOUT_MS);

      // The requests' pool: the probe queues behind the burst and says "no".
      await expect(probeDatabase(READINESS_TIMEOUT_MS, onMain)).resolves.toBe(
        false,
      );

      await releaseThePool();
    },
    TEST_TIMEOUT_MS,
  );
});
