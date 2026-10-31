import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A replica refuses to serve a database that lacks its build's migrations.
 *
 * The API image no longer migrates: the release image does, once, before
 * the rollout. A replica started on a schema it was not written for (a tag
 * deployed without the job) came up "healthy" — the liveness touches no
 * table — and answered 500 wherever it read a new column. Now the boot's
 * first step, infra/scripts/wait-for-postgres.ts with --require-migrations
 * (docker-entrypoint.sh, `serve`), checks the build's last migration
 * (build/schema-version.json) against `_prisma_migrations` and exits first.
 *
 * Run for real here, against the migrated E2E database and an empty one.
 */
const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const script = resolve(
  process.cwd(),
  "infra",
  "scripts",
  "wait-for-postgres.ts",
);

const LATEST = readdirSync(resolve(process.cwd(), "prisma", "migrations"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .pop() as string;

const emptyName = `trajetto_schema_${randomUUID().replace(/-/g, "")}`;
const dir = mkdtempSync(join(tmpdir(), "trajetto-schema-"));

function urlFor(database: string): string {
  const url = new URL(process.env.DATABASE_URL as string);

  url.pathname = `/${database}`;
  url.searchParams.set("schema", "public");

  return url.toString();
}

function admin(): PrismaClient {
  const url = new URL(process.env.DATABASE_URL as string);

  url.pathname = "/postgres";
  url.searchParams.delete("schema");

  return createPrismaClient({ log: [] }, { url: url.toString() });
}

/** A build/schema-version.json naming `migration`. */
function schemaVersion(migration: string): string {
  const file = join(dir, `${randomUUID()}.json`);

  writeFileSync(file, JSON.stringify({ latestMigration: migration }));

  return file;
}

beforeAll(async () => {
  const client = admin();

  await client.$executeRawUnsafe(`CREATE DATABASE "${emptyName}"`);
  await client.$disconnect();
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });

  const client = admin();

  try {
    await client.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${emptyName}" WITH (FORCE)`,
    );
  } finally {
    await client.$disconnect();
  }
});

function boot(args: string[], databaseUrl = process.env.DATABASE_URL) {
  const result = spawnSync(process.execPath, [tsx, script, ...args], {
    env: {
      ...process.env,
      // What a replica runs with; the empty database is let through the
      // bootstrap guard, so the schema guard is what answers.
      NODE_ENV: "production",
      ALLOW_EMPTY_DATABASE_BOOTSTRAP: "true",
      DATABASE_URL: databaseUrl,
      WAIT_FOR_POSTGRES_TIMEOUT_MS: "10000",
    },
    encoding: "utf8",
    timeout: 60_000,
  });

  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

describe("the boot's schema check (--require-migrations)", () => {
  it("passes the migrated database, at the repository's last migration", () => {
    const { status, output } = boot([
      "--require-migrations",
      schemaVersion(LATEST),
    ]);

    expect(status, output).toBe(0);
  });

  it("refuses a database that lacks the build's migration, naming it", () => {
    const missing = "29991231235959_from_a_build_ahead";
    const { status, output } = boot([
      "--require-migrations",
      schemaVersion(missing),
    ]);

    expect(status, output).toBe(1);
    expect(output).toContain(`O banco não tem a migration ${missing}`);
    expect(output).toContain("trajetto-api-migrate");
  });

  it("refuses a database that was never migrated", () => {
    const { status, output } = boot(
      ["--require-migrations", schemaVersion(LATEST)],
      urlFor(emptyName),
    );

    expect(status, output).toBe(1);
    expect(output).toContain(`O banco não tem a migration ${LATEST}`);
  });

  it("takes a broken build for what it is, before waiting for anything", () => {
    const { status, output } = boot([
      "--require-migrations",
      join(dir, "missing.json"),
    ]);

    expect(status, output).toBe(64);
    expect(output).toContain("não diz a última migration do build");
  });

  it("asks nothing of the schema without the flag (the release step, yarn dev)", () => {
    const { status, output } = boot([], urlFor(emptyName));

    expect(status, output).toBe(0);
  });
}, 120_000);
