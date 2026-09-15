import "dotenv/config";

import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

import { Environment } from "vitest";
import { PrismaClient } from "@prisma/client";

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
 */
function connectionFor(database: string): string {
  if (!process.env.DATABASE_URL) {
    throw new Error("Please provide a DATABASE_URL environment variable");
  }

  const url = new URL(process.env.DATABASE_URL);

  // The path is `/<database>`; the schema stays public, which is where a fresh
  // database puts the extension anyway.
  url.pathname = `/${database}`;
  url.searchParams.set("schema", "public");

  return url.toString();
}

/**
 * A connection to the server rather than to the test database, since you
 * cannot create or drop a database while connected to it.
 */
function adminClient(): PrismaClient {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = "/postgres";
  url.searchParams.delete("schema");

  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

export default <Environment>{
  name: "prisma",
  transformMode: "ssr",
  async setup() {
    const originalUrl = process.env.DATABASE_URL as string;

    // Quoted everywhere it appears: a UUID starts with a digit often enough,
    // and an unquoted identifier that does is a syntax error.
    const database = `trajetto_test_${randomUUID().replace(/-/g, "")}`;

    const admin = adminClient();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
    await admin.$disconnect();

    process.env.DATABASE_URL = connectionFor(database);
    execSync("yarn prisma migrate deploy", { stdio: "pipe" });

    return {
      async teardown() {
        process.env.DATABASE_URL = originalUrl;

        const cleanup = adminClient();

        try {
          // WITH (FORCE) terminates connections the test left open; without it
          // a single leaked client makes the drop hang and the database
          // accumulates run after run.
          await cleanup.$executeRawUnsafe(
            `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
          );
        } finally {
          await cleanup.$disconnect();
        }
      },
    };
  },
};
