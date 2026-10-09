import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The boot refuses to prepare an EMPTY production database on its own.
 *
 * `trajetto-database` sits on a local volume. Reschedule the task on another
 * node, remove the volume, rename the stack or point at a new Dokploy database
 * and Postgres comes back empty — initdb, a healthy pg_isready, a readiness
 * that only runs SELECT 1. The next API boot then applied every migration,
 * created the MASTER user with the initial password and came up "healthy"
 * with zero tenants, taking new writes into a database that was not the real
 * one. Now it stops, loudly, before migrating or seeding anything; a
 * genuinely new installation says so once with ALLOW_EMPTY_DATABASE_BOOTSTRAP.
 *
 * The real infra/scripts/wait-for-postgres.ts — the first step of
 * docker-entrypoint.sh in both modes — runs here against a real, empty
 * database.
 */
const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const script = resolve(process.cwd(), "infra", "scripts", "wait-for-postgres.ts");

const emptyName = `trajetto_empty_${randomUUID().replace(/-/g, "")}`;

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

  return new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
}

beforeAll(async () => {
  const client = admin();

  await client.$executeRawUnsafe(`CREATE DATABASE "${emptyName}"`);
  await client.$disconnect();
});

afterAll(async () => {
  const client = admin();

  try {
    await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${emptyName}" WITH (FORCE)`);
  } finally {
    await client.$disconnect();
  }
});

function boot(databaseUrl: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [tsx, script], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      WAIT_FOR_POSTGRES_TIMEOUT_MS: "10000",
      ALLOW_EMPTY_DATABASE_BOOTSTRAP: "",
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });

  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("the first boot step in production", () => {
  it("refuses a database no migration has ever touched", () => {
    const { status, output } = boot(urlFor(emptyName));

    expect(status, output).toBe(1);
    expect(output).toContain("ALLOW_EMPTY_DATABASE_BOOTSTRAP");
  });

  it("lets a new installation through when told to, once", () => {
    const { status, output } = boot(urlFor(emptyName), {
      ALLOW_EMPTY_DATABASE_BOOTSTRAP: "true",
    });

    expect(status, output).toBe(0);
  });

  it("passes the real, migrated database", () => {
    const { status, output } = boot(process.env.DATABASE_URL as string);

    expect(status, output).toBe(0);
  });

  it("does not stand in the way outside production", () => {
    const { status, output } = boot(urlFor(emptyName), { NODE_ENV: "development" });

    expect(status, output).toBe(0);
  });
}, 120_000);
