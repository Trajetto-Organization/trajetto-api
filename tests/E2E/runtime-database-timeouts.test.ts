import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The production connection strings, as written in compose.production.yaml,
 * opened by Prisma against a real Postgres.
 *
 * Production ran with no statement_timeout, lock_timeout or
 * idle_in_transaction_session_timeout anywhere: a runaway query had no
 * ceiling, and the nightly partition DDL could queue every ping behind an
 * ACCESS EXCLUSIVE request with no bound. The ceilings travel in the URL's
 * `options` — only on the runtime URL, because a migration cancelled halfway
 * is worse than a slow one.
 *
 * Reading the compose text would not prove the encoding survives Prisma's
 * URL parsing; opening the connection does.
 */
const compose = readFileSync(resolve(process.cwd(), "compose.production.yaml"), "utf8");

function apiVariable(name: string): string | undefined {
  const api = compose.slice(compose.indexOf("\n  api:"));

  return api.match(new RegExp(`^\\s+${name}: (.+?)\\s*$`, "m"))?.[1];
}

/** The compose value with ${...} filled in from this test's own database. */
function materialise(template: string): string {
  const own = new URL(process.env.DATABASE_URL as string);

  const values: Record<string, string> = {
    POSTGRES_USERNAME: own.username,
    POSTGRES_PASSWORD: own.password,
    POSTGRES_HOST: own.hostname,
    POSTGRES_PORT: own.port || "5432",
    POSTGRES_DATABASE: own.pathname.slice(1),
  };

  return template.replace(/\$\{(\w+)(?::?-[^}]*)?\}/g, (_, key: string) => values[key] ?? "");
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
    const template = apiVariable("DATABASE_URL");

    expect(template, "DATABASE_URL do serviço api").toBeTruthy();

    const settings = await settingsOf(materialise(template!));

    expect(settings.statement).toBe("30s");
    expect(settings.lock).toBe("5s");
    expect(settings.idle).toBe("1min");
  });
});

describe("the migration connection", () => {
  it("exists, and carries none of the runtime ceilings", async () => {
    const template = apiVariable("MIGRATION_DATABASE_URL");

    expect(template, "MIGRATION_DATABASE_URL do serviço api").toBeTruthy();

    const settings = await settingsOf(materialise(template!));

    expect(settings.statement).toBe("0");
    expect(settings.lock).toBe("0");
  });
});
