import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { disposableDatabaseRefusal } from "../../load/lib/disposable-database";

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
