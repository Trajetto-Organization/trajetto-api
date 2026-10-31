import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

import { Environment } from "vitest";
import pg from "pg";

import {
  adminConnection,
  connectionFor,
  loadTestEnv,
  testDatabaseUrl,
} from "./database-url";

// dotenv + dotenv-expand, as src/env does: `.env` writes DATABASE_URL with
// `${VAR}` placeholders.
loadTestEnv();

/**
 * An isolated database per test file, created and dropped around it.
 *
 * It used to be an isolated SCHEMA inside one shared database, which reads as
 * the lighter option and does not work: `20260910120000_chat_scale_indexes`
 * runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` and then builds a GIN index
 * with `gin_trgm_ops`. Extensions in Postgres are DATABASE-scoped and live in
 * exactly one schema — so the first run installed pg_trgm into its own schema,
 * and every run after that found `IF NOT EXISTS` already satisfied while the
 * operator class sat in a schema no longer on the search_path. The migration
 * failed with 42704, and the integration suite was usable exactly once per
 * database. In CI, where the database outlives the run, that means never.
 *
 * A database per file sidesteps it completely: each one gets its own pg_trgm
 * in its own public schema, with nothing shared to collide over. It also
 * removes a subtler hazard the schema approach had — `DROP EXTENSION ...
 * CASCADE`, the other obvious fix, would have dropped the trigram index out
 * from under any test file running in parallel.
 *
 * The cost is one CREATE DATABASE per file. `migrate deploy` was already being
 * paid for, and it dominates.
 *
 * The two administrative statements go through a plain pg Client: this
 * package is copied into node_modules, so it cannot reach the app's client
 * factory, and CREATE/DROP DATABASE need nothing Prisma adds.
 */
async function onAdminConnection(
  baseUrl: string,
  statement: string,
): Promise<void> {
  const admin = new pg.Client({
    connectionString: adminConnection(baseUrl),
    connectionTimeoutMillis: 10_000,
  });

  await admin.connect();

  try {
    await admin.query(statement);
  } finally {
    await admin.end();
  }
}

/**
 * How far apart the database's clock and this process's may be.
 *
 * The queues compare the database's now() with times the app wrote from ITS
 * clock: Prisma fills `availableAt @default(now())` in the client, and every
 * backoff is `new Date(Date.now() + delay)`. A row written "now" is not due
 * yet to a database whose clock is behind, so the claim skips it and the test
 * reads it untouched — notification-pipeline.test.ts failed that way, with
 * nothing wrong in the pipeline.
 *
 * On a Linux runner (the CI) the container reads the host's own clock and the
 * gap is zero. Docker Desktop's VM drifts: by seconds after the machine
 * sleeps, and by tens of milliseconds under a long, heavy run (measured on
 * 30/10/2026: 21–43 ms behind during the replica phase, back to zero once
 * idle). Seconds break nearly every queue test, so the suite refuses to start
 * on them. Tens of milliseconds only break a test that claims a row right
 * after inserting it — and come and go on their own — so they are reported
 * on the file instead of refusing it: a failure in that file is then read for
 * what it is.
 */
const DATABASE_CLOCK_REFUSE_MS = 1_000;
const DATABASE_CLOCK_WARN_MS = 20;

const clockAdvice =
  "No Docker Desktop, rode `wsl --shutdown` (ou reinicie o Docker Desktop) e rode os testes de novo.";

async function assertDatabaseClockAligned(baseUrl: string): Promise<void> {
  const admin = new pg.Client({
    connectionString: adminConnection(baseUrl),
    connectionTimeoutMillis: 10_000,
  });

  await admin.connect();

  let behindMs = Number.POSITIVE_INFINITY;
  let aheadMs = Number.POSITIVE_INFINITY;

  try {
    // The statement runs between `before` and `after`, so a database time
    // below `before` is a clock behind — whatever the latency — and one past
    // `after` a clock ahead. The best of three keeps a slow round trip from
    // reading as drift.
    for (let probe = 0; probe < 3; probe += 1) {
      const before = Date.now();
      const { rows } = await admin.query<{ at: Date }>(
        "SELECT clock_timestamp() AS at",
      );
      const after = Date.now();
      const at = rows[0].at.getTime();

      behindMs = Math.min(behindMs, before - at);
      aheadMs = Math.min(aheadMs, at - after);
    }
  } finally {
    await admin.end();
  }

  const refused =
    behindMs > DATABASE_CLOCK_REFUSE_MS || aheadMs > DATABASE_CLOCK_REFUSE_MS;

  if (refused) {
    const gap =
      behindMs > 0
        ? `${Math.round(behindMs)} ms atrás`
        : `${Math.round(aheadMs)} ms à frente`;

    throw new Error(
      `O relógio do Postgres de teste está ${gap} do relógio desta máquina. ` +
        "As filas comparam o now() do banco com horários gravados pelo processo, e com essa diferença " +
        "as linhas não vencem (ou vencem) na hora que os testes esperam. " +
        clockAdvice,
    );
  }

  if (behindMs > DATABASE_CLOCK_WARN_MS) {
    process.stderr.write(
      `\n[vitest-environment-prisma] O relógio do Postgres de teste está ${Math.round(behindMs)} ms atrás ` +
        "do relógio desta máquina: um teste que reivindica uma linha logo depois de gravá-la pode falhar " +
        `neste arquivo sem defeito no código. ${clockAdvice}\n`,
    );
  }
}

export default <Environment>{
  name: "prisma",
  transformMode: "ssr",
  async setup() {
    const originalUrl = process.env.DATABASE_URL;
    const baseUrl = testDatabaseUrl();

    await assertDatabaseClockAligned(baseUrl);

    // Quoted everywhere it appears: a UUID starts with a digit often enough,
    // and an unquoted identifier that does is a syntax error.
    const database = `trajetto_test_${randomUUID().replace(/-/g, "")}`;

    await onAdminConnection(baseUrl, `CREATE DATABASE "${database}"`);

    process.env.DATABASE_URL = connectionFor(baseUrl, database);
    execSync("yarn prisma migrate deploy", { stdio: "pipe" });

    return {
      async teardown() {
        if (originalUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = originalUrl;

        // WITH (FORCE) terminates connections the test left open; without it
        // a single leaked client makes the drop hang and the database
        // accumulates run after run.
        await onAdminConnection(
          baseUrl,
          `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
        );
      },
    };
  },
};
