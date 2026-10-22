import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  productionDatabaseUrlFor,
  type ProductionDatabaseVariable,
} from "../support/production-database-url";

/**
 * The production connection strings, as modelled in .env.example (the API
 * Application's environment in Dokploy is filled from it), opened by Prisma
 * against a real Postgres.
 *
 * Production ran with no statement_timeout, lock_timeout or
 * idle_in_transaction_session_timeout anywhere: a runaway query had no
 * ceiling, and the nightly partition DDL could queue every ping behind an
 * ACCESS EXCLUSIVE request with no bound. The ceilings travel in the URL's
 * `options` — only on the runtime URL, because a migration cancelled halfway
 * is worse than a slow one.
 *
 * Reading the template's text would not prove the encoding survives Prisma's
 * URL parsing; opening the connection does.
 */

/** The production template pointed at this test's own database. */
function materialise(name: ProductionDatabaseVariable): string {
  const own = new URL(process.env.DATABASE_URL as string);

  return productionDatabaseUrlFor(name, {
    username: own.username,
    password: own.password,
    host: own.hostname,
    port: own.port || "5432",
    database: own.pathname.slice(1),
  }).toString();
}

const clients: PrismaClient[] = [];

afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});

async function settingsOf(url: string) {
  const client = new PrismaClient({ datasources: { db: { url } }, log: [] });
  clients.push(client);

  const [row] = await client.$queryRawUnsafe<
    Array<{ statement: string; lock: string; idle: string }>
  >(
    `SELECT current_setting('statement_timeout') AS statement,
            current_setting('lock_timeout') AS lock,
            current_setting('idle_in_transaction_session_timeout') AS idle`,
  );

  return row;
}

describe("the API's runtime connection in production", () => {
  it("has a ceiling on statements, lock waits and idle transactions", async () => {
    const settings = await settingsOf(materialise("DATABASE_URL"));

    expect(settings.statement).toBe("30s");
    expect(settings.lock).toBe("5s");
    expect(settings.idle).toBe("1min");
  });
});

describe("the migration connection", () => {
  it("exists, and carries none of the runtime ceilings", async () => {
    const settings = await settingsOf(materialise("MIGRATION_DATABASE_URL"));

    expect(settings.statement).toBe("0");
    expect(settings.lock).toBe("0");
  });
});
