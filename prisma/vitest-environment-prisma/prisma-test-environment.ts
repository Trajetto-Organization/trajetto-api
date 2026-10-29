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

export default <Environment>{
  name: "prisma",
  transformMode: "ssr",
  async setup() {
    const originalUrl = process.env.DATABASE_URL;
    const baseUrl = testDatabaseUrl();

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
