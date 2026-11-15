import { describe, expect, it } from "vitest";

import {
  pgStatStatementsStateOf,
  readPgStatStatementsState,
} from "@/shared/health/pg-stat-statements-state";

/**
 * How the answer of the database becomes one of three states (F1-05).
 *
 * Until the new Postgres image (wave 3), production has the extension and no
 * preload: the view refuses every read with SQLSTATE 55000. That is
 * "not_loaded", the expected state of today, and must never surface as an
 * error on /health/metrics or in the snapshot job. Anything else the
 * database says is not a state: it is thrown, so a broken connection is not
 * reported as "the extension is missing".
 */
function refused(sqlState: string) {
  return Object.assign(new Error(`postgres ${sqlState}`), {
    meta: { driverAdapterError: { cause: { originalCode: sqlState } } },
  });
}

describe("pgStatStatementsStateOf", () => {
  it("reads missing when the extension is not installed", () => {
    expect(pgStatStatementsStateOf({ installed: false })).toBe("missing");
  });

  it("reads ready when the view answered", () => {
    expect(pgStatStatementsStateOf({ installed: true, probe: "ok" })).toBe(
      "ready",
    );
  });

  it("reads not_loaded when the library is not preloaded (55000)", () => {
    expect(
      pgStatStatementsStateOf({ installed: true, probe: refused("55000") }),
    ).toBe("not_loaded");
  });

  it("reads missing when the view vanished between the two reads", () => {
    for (const sqlState of ["42P01", "42883"]) {
      expect(
        pgStatStatementsStateOf({ installed: true, probe: refused(sqlState) }),
      ).toBe("missing");
    }
  });

  it("has no state for any other failure", () => {
    expect(
      pgStatStatementsStateOf({ installed: true, probe: refused("57P01") }),
    ).toBeUndefined();
    expect(
      pgStatStatementsStateOf({
        installed: true,
        probe: new Error("connection reset"),
      }),
    ).toBeUndefined();
  });
});

describe("readPgStatStatementsState", () => {
  function client(schema: string | null, probe: () => Promise<unknown>) {
    const queries: string[] = [];

    return {
      queries,
      $queryRaw: async (query: { strings?: readonly string[] }) => {
        const text = (query.strings ?? []).join("?");
        queries.push(text);

        if (text.includes("pg_extension")) return schema ? [{ schema }] : [];

        return probe();
      },
    };
  }

  it("does not probe the view when the extension is missing", async () => {
    const fake = client(null, async () => {
      throw new Error("must not be called");
    });

    expect(await readPgStatStatementsState(fake as never)).toBe("missing");
    expect(fake.queries).toHaveLength(1);
  });

  it("probes the view in the extension's own schema", async () => {
    const fake = client('odd"schema', async () => [{ dealloc: 0 }]);

    expect(await readPgStatStatementsState(fake as never)).toBe("ready");
    expect(fake.queries[1]).toContain('"odd""schema".pg_stat_statements_info');
  });

  it("is not_loaded, not an error, without the preload", async () => {
    const fake = client("public", async () => {
      throw refused("55000");
    });

    expect(await readPgStatStatementsState(fake as never)).toBe("not_loaded");
  });

  it("throws what is not a state", async () => {
    const fake = client("public", async () => {
      throw refused("57P01");
    });

    await expect(readPgStatStatementsState(fake as never)).rejects.toThrow(
      "postgres 57P01",
    );
  });
});
