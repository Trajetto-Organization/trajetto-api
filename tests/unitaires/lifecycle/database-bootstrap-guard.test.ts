import { describe, expect, it } from "vitest";

import {
  emptyDatabaseRefusal,
  freshDatabaseRefusal,
  type RawQueryClient,
} from "../../../infra/scripts/database-bootstrap-guard";

/**
 * The decision behind the boot's refusal of an empty production database.
 * The wiring into wait-for-postgres (and a real empty Postgres) is covered by
 * tests/E2E/empty-database-guard.test.ts.
 */
function fakeClient(tablePresent: boolean, applied: number) {
  const queries: string[] = [];

  const client: RawQueryClient = {
    async $queryRawUnsafe<T>(query: string) {
      queries.push(query);

      return (
        query.includes("to_regclass")
          ? [{ present: tablePresent }]
          : [{ applied }]
      ) as T;
    },
  };

  return { client, queries };
}

describe("freshDatabaseRefusal", () => {
  it("refuses production with no applied migration", () => {
    expect(
      freshDatabaseRefusal({
        nodeEnv: "production",
        appliedMigrations: 0,
        allowBootstrap: false,
      }),
    ).toMatch(/ALLOW_EMPTY_DATABASE_BOOTSTRAP/);
  });

  it("goes ahead when a new installation says so", () => {
    expect(
      freshDatabaseRefusal({
        nodeEnv: "production",
        appliedMigrations: 0,
        allowBootstrap: true,
      }),
    ).toBeNull();
  });

  it("goes ahead on a database that has been migrated before", () => {
    expect(
      freshDatabaseRefusal({
        nodeEnv: "production",
        appliedMigrations: 5,
        allowBootstrap: false,
      }),
    ).toBeNull();
  });

  it.each(["development", "test", undefined])(
    "never stands in the way of %s",
    (nodeEnv) => {
      expect(
        freshDatabaseRefusal({
          nodeEnv,
          appliedMigrations: 0,
          allowBootstrap: false,
        }),
      ).toBeNull();
    },
  );
});

describe("emptyDatabaseRefusal", () => {
  it("refuses a database without _prisma_migrations, without counting rows", async () => {
    const { client, queries } = fakeClient(false, 0);

    await expect(
      emptyDatabaseRefusal(client, { NODE_ENV: "production" }),
    ).resolves.toMatch(/Banco vazio em produção/);
    expect(queries).toHaveLength(1);
  });

  it("refuses a table with no finished migration", async () => {
    const { client } = fakeClient(true, 0);

    await expect(
      emptyDatabaseRefusal(client, { NODE_ENV: "production" }),
    ).resolves.not.toBeNull();
  });

  it("accepts a migrated database", async () => {
    const { client } = fakeClient(true, 108);

    await expect(
      emptyDatabaseRefusal(client, { NODE_ENV: "production" }),
    ).resolves.toBeNull();
  });

  it("does not even ask when the answer cannot matter", async () => {
    for (const env of [
      { NODE_ENV: "development" },
      { NODE_ENV: "production", ALLOW_EMPTY_DATABASE_BOOTSTRAP: "true" },
    ]) {
      const { client, queries } = fakeClient(false, 0);

      await expect(emptyDatabaseRefusal(client, env)).resolves.toBeNull();
      expect(queries).toEqual([]);
    }
  });
});
