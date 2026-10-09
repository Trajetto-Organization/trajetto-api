import { describe, expect, it } from "vitest";

import {
  adminConnection,
  connectionFor,
  testDatabaseUrl,
} from "../../../prisma/vitest-environment-prisma/database-url";

/**
 * TEST-ENV-1: `.env` writes DATABASE_URL with `${VAR}` placeholders. The
 * integration environment used to read it through plain `dotenv/config` and
 * hand the literal to `new URL()`, which fails with "Invalid URL".
 */
const TEMPLATE =
  "postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DATABASE}?schema=public";

const VARS = {
  POSTGRES_USER: "trajetto",
  POSTGRES_PASSWORD: "not-a-secret",
  POSTGRES_HOST: "localhost",
  POSTGRES_PORT: "54321",
  POSTGRES_DATABASE: "trajetto-database",
};

describe("the integration environment's DATABASE_URL", () => {
  it("is not a URL before the placeholders are expanded (what the old environment passed on)", () => {
    expect(() => new URL(TEMPLATE)).toThrow();
  });

  it("expands ${VAR} placeholders from the environment", () => {
    const url = testDatabaseUrl({ DATABASE_URL: TEMPLATE, ...VARS });

    expect(url).toBe(
      "postgresql://trajetto:not-a-secret@localhost:54321/trajetto-database?schema=public",
    );
    expect(new URL(url).port).toBe("54321");
  });

  it("honours ${VAR:-default} and prefers TEST_DATABASE_URL", () => {
    expect(
      testDatabaseUrl({
        DATABASE_URL: "postgresql://x@nowhere:1/ignored",
        TEST_DATABASE_URL: "postgresql://u@${HOST:-localhost}:5432/db",
      }),
    ).toBe("postgresql://u@localhost:5432/db");
  });

  it("names the placeholder that has no value instead of failing on an opaque Invalid URL", () => {
    expect(() =>
      testDatabaseUrl({
        DATABASE_URL: TEMPLATE,
        ...VARS,
        POSTGRES_PORT: undefined,
      }),
    ).toThrow("${POSTGRES_PORT}");
  });

  it("requires a URL at all", () => {
    expect(() => testDatabaseUrl({})).toThrow(/DATABASE_URL/);
  });

  it("derives the per-file database and the admin connection from the expanded URL", () => {
    const base = testDatabaseUrl({ DATABASE_URL: TEMPLATE, ...VARS });

    const perFile = new URL(connectionFor(base, "trajetto_test_abc"));
    expect(perFile.pathname).toBe("/trajetto_test_abc");
    expect(perFile.searchParams.get("schema")).toBe("public");
    expect(perFile.port).toBe("54321");

    const admin = new URL(adminConnection(base));
    expect(admin.pathname).toBe("/postgres");
    expect(admin.searchParams.has("schema")).toBe(false);
  });
});
