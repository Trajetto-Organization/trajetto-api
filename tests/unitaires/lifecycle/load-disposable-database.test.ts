import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertSeedTargetEmpty,
  disposableDatabaseRefusal,
  seedTargetRefusal,
} from "../../load/lib/disposable-database";

const url = (hostPort: string, extra = "") =>
  `postgresql://trajetto:segredo${extra}@${hostPort}/load_test?schema=public`;

describe("disposableDatabaseRefusal", () => {
  it("accepts the shared disposable container on 54321", () => {
    expect(disposableDatabaseRefusal(url("localhost:54321"), {})).toBeNull();
    expect(disposableDatabaseRefusal(url("127.0.0.1:54321"), {})).toBeNull();
  });

  it("accepts the harness Postgres on the LOAD_PG_PORT the compose file publishes", () => {
    // The documented path when 54321 is held by the shared test container.
    expect(
      disposableDatabaseRefusal(url("localhost:54331"), {
        LOAD_PG_PORT: "54331",
      }),
    ).toBeNull();
    expect(disposableDatabaseRefusal(url("localhost:54331"), {})).toMatch(
      /LOAD_PG_PORT/,
    );
  });

  it("refuses a URL that only mentions 54321 outside the port", () => {
    // The old substring check let both through.
    expect(
      disposableDatabaseRefusal(url("localhost:5432", "54321"), {}),
    ).not.toBeNull();
    expect(
      disposableDatabaseRefusal("postgresql://u:p@localhost:5432/db54321", {}),
    ).not.toBeNull();
  });

  it("never accepts the developer's port, even when LOAD_PG_PORT names it", () => {
    expect(
      disposableDatabaseRefusal(url("localhost:5432"), {
        LOAD_PG_PORT: "5432",
      }),
    ).not.toBeNull();
    expect(
      disposableDatabaseRefusal("postgresql://u:p@localhost/load_test", {}),
    ).not.toBeNull();
  });

  it("refuses a non-loopback host on an allowed port", () => {
    expect(
      disposableDatabaseRefusal(url("db.example.com:54321"), {}),
    ).not.toBeNull();
  });

  it("refuses a missing or unparsable URL", () => {
    expect(disposableDatabaseRefusal(undefined, {})).not.toBeNull();
    expect(disposableDatabaseRefusal("not a url", {})).not.toBeNull();
  });
});

describe("every writing script of tests/load runs the guard", () => {
  // mint-master.ts had no guard at all: it created a MASTER and refresh
  // families in whatever DATABASE_URL pointed to.
  for (const script of [
    "seed.ts",
    "mint-master.ts",
    "mint-browser-users.ts",
    "mint-password.ts",
    "mint-two-factor-code.ts",
  ]) {
    it(script, () => {
      const source = readFileSync(
        resolve(__dirname, "../../load", script),
        "utf8",
      );

      expect(source).toContain("assertDisposableDatabase(");
      expect(source).not.toMatch(/DATABASE_URL\?\.includes\(/);
    });
  }
});

describe("seedTargetRefusal", () => {
  // The port says where the connection goes, not what is there: a tunnel on
  // LOAD_PG_PORT to production's Database (same server as the disposable
  // one in the prod-like flow) passed the port check, and the tier then
  // dropped the hot tables' indexes and loaded millions of rows with the
  // foreign keys unchecked. A freshly migrated database has no company;
  // production always has.
  it("accepts a database with no company the seed did not write", () => {
    expect(
      seedTargetRefusal({ database: "load_test", foreignCompanies: 0 }),
    ).toBeNull();
  });

  it("refuses a database that already holds companies, naming it and the tunnel", () => {
    const refusal = seedTargetRefusal({
      database: "trajetto",
      foreignCompanies: 3,
    });

    expect(refusal).toMatch(/"trajetto"/);
    expect(refusal).toMatch(/3 empresas/);
    expect(refusal).toMatch(/LOAD_PG_PORT/);
  });

  it("says the count is a floor once it reaches the cap", () => {
    expect(
      seedTargetRefusal({ database: "trajetto", foreignCompanies: 100 }),
    ).toMatch(/100 ou mais empresas/);
  });
});

describe("assertSeedTargetEmpty", () => {
  it("counts the companies other than the seed's own, and throws on any", async () => {
    const calls: unknown[][] = [];
    const query =
      (foreignCompanies: number) => async (sql: string, values: unknown[]) => {
        calls.push(values);
        expect(sql).toMatch(/FROM "business"/);
        expect(sql).toMatch(/current_database\(\)/);
        return [{ database: "load_test", foreignCompanies }];
      };

    await expect(assertSeedTargetEmpty(query(0))).resolves.toBeUndefined();
    await expect(
      assertSeedTargetEmpty(query(0), "own-company"),
    ).resolves.toBeUndefined();
    await expect(assertSeedTargetEmpty(query(1))).rejects.toThrow(
      /já tem 1 empresa/,
    );

    expect(calls).toEqual([[null], ["own-company"], [null]]);
  });
});

describe("the seed checks the target is empty before it writes", () => {
  const seed = readFileSync(resolve(__dirname, "../../load/seed.ts"), "utf8");

  function body(name: string): string {
    const start = seed.indexOf(`async function ${name}(`);

    expect(start).toBeGreaterThanOrEqual(0);

    const next = seed.indexOf("\nasync function ", start + 1);

    return seed.slice(start, next < 0 ? undefined : next);
  }

  it("in main, before the first company is written", () => {
    const main = body("main");
    const check = main.indexOf("assertSeedTargetEmpty(");

    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(main.indexOf("seedTenant("));
  });

  it("in the tier, on its own session, before the indexes are dropped", () => {
    const tier = body("seedTier");
    const check = tier.indexOf("assertSeedTargetEmpty(");

    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(tier.indexOf("for (const file of files)"));
    expect(tier.slice(check, tier.indexOf(";", check))).toMatch(/businessId/);
  });
});
