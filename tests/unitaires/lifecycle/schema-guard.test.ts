import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RawQueryClient } from "../../../infra/scripts/database-bootstrap-guard";
import {
  missingMigrationRefusal,
  readSchemaVersion,
  schemaRefusal,
} from "../../../infra/scripts/schema-guard";
import { sandbox, type Sandbox } from "./support/shell-harness";

/**
 * The boot's refusal of a database without all of the build's migrations.
 * The API image no longer migrates (the release image does, once, before the
 * rollout); this is what keeps a replica from serving a schema older than
 * its build. The wiring into wait-for-postgres, on a real Postgres, is in
 * tests/E2E/schema-guard.test.ts; the image's own refusal, in the smoke test
 * of deploy.yml.
 */
const ROOT = process.cwd();

/** A client whose `_prisma_migrations` has `applied` finished rows. */
function fakeClient(tablePresent: boolean, applied: string[]) {
  const queries: Array<{ query: string; values: unknown[] }> = [];

  const client: RawQueryClient = {
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]) {
      queries.push({ query, values });

      return (
        query.includes("to_regclass")
          ? [{ present: tablePresent }]
          : applied.map((migration_name) => ({ migration_name }))
      ) as T;
    },
  };

  return { client, queries };
}

const OLDER = "20261027090000_add_route_window";
const NEWEST = "20261028140100_import_reversal_progress";
const BUILD = [OLDER, NEWEST];

describe("schemaRefusal", () => {
  it("goes ahead when every migration of the build is applied", async () => {
    const { client } = fakeClient(true, [...BUILD, "20261029000000_newer"]);

    expect(await schemaRefusal(client, BUILD)).toBeNull();
  });

  it("refuses when one is not, naming it and the Application that migrates", async () => {
    const { client } = fakeClient(true, [OLDER]);
    const refusal = await schemaRefusal(client, BUILD);

    expect(refusal).toBe(missingMigrationRefusal([NEWEST]));
    expect(refusal).toContain(`O banco não tem a migration ${NEWEST}`);
    expect(refusal).toContain("Application trajetto-api-migrate");
  });

  // Prisma names a migration when it is created, not when it is merged: a
  // branch merged late brings one that sorts before migrations the database
  // already has. Checking only the newest name let that replica serve.
  it("refuses a missing OLDER migration even when the newest one is applied", async () => {
    const { client } = fakeClient(true, [NEWEST]);

    expect(await schemaRefusal(client, BUILD)).toBe(
      missingMigrationRefusal([OLDER]),
    );
  });

  it("names the first missing migrations and counts the rest", () => {
    const missing = Array.from(
      { length: 6 },
      (_, at) => `2026102${at}000000_m${at}`,
    );
    const refusal = missingMigrationRefusal(missing);

    // The smoke test of deploy.yml greps this phrase.
    expect(refusal).toContain(`O banco não tem a migration ${missing[0]} `);
    expect(refusal).toContain(
      `(nem outras 5: ${missing[1]}, ${missing[2]}, ${missing[3]}, …)`,
    );
  });

  it("refuses a database without _prisma_migrations, without querying a missing table", async () => {
    const { client, queries } = fakeClient(false, BUILD);

    expect(await schemaRefusal(client, [NEWEST, OLDER])).toBe(
      missingMigrationRefusal(BUILD),
    );
    expect(queries).toHaveLength(1);
  });

  it("counts only finished migrations that were not rolled back, with nothing interpolated", async () => {
    const { client, queries } = fakeClient(true, BUILD);

    await schemaRefusal(client, BUILD);

    const lookup = queries[1];

    expect(lookup.query).toContain("finished_at IS NOT NULL");
    expect(lookup.query).toContain("rolled_back_at IS NULL");
    expect(lookup.query).not.toContain(NEWEST);
    expect(lookup.values).toEqual([]);
  });
});

describe("readSchemaVersion", () => {
  let box: Sandbox | undefined;

  afterEach(() => {
    box?.dispose();
    box = undefined;
  });

  const write = (content: string) => {
    box = sandbox();

    return box.file("build/schema-version.json", content);
  };

  it("reads the migrations the build recorded, sorted", () => {
    const file = write(JSON.stringify({ migrations: [NEWEST, OLDER] }));

    expect(readSchemaVersion(file)).toEqual({ migrations: BUILD });
  });

  it("accepts the one migration with an empty name", () => {
    const file = write(JSON.stringify({ migrations: ["20250716112605_"] }));

    expect(readSchemaVersion(file).migrations).toEqual(["20250716112605_"]);
  });

  it.each([
    ["no list", "{}"],
    ["an empty list", JSON.stringify({ migrations: [] })],
    [
      "something that is not a migration directory",
      JSON.stringify({ migrations: [OLDER, "latest"] }),
    ],
    ["a path", JSON.stringify({ migrations: ["../20261028140100_x"] })],
    [
      "only the newest name (an older format)",
      JSON.stringify({ latestMigration: NEWEST }),
    ],
    ["not JSON", "20261028140100_x"],
    ["nothing in it", ""],
  ])("refuses a file with %s, naming the file", (_case, content) => {
    const file = write(content);

    expect(() => readSchemaVersion(file)).toThrow(
      `${file} não lista as migrations do build`,
    );
  });

  it("refuses a missing file, naming it", () => {
    box = sandbox();

    const file = `${box.root}/build/schema-version.json`;

    expect(() => readSchemaVersion(file)).toThrow(file);
  });

  it("takes every migration directory of the repository", () => {
    const names = readdirSync(resolve(ROOT, "prisma/migrations"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(names.length).toBeGreaterThan(100);

    const file = write(JSON.stringify({ migrations: names }));

    expect(readSchemaVersion(file).migrations).toEqual([...names].sort());
  });
});

describe("where the build records it, and where the boot reads it", () => {
  it("tsup writes every migration directory to build/schema-version.json", () => {
    const tsup = readFileSync(resolve(ROOT, "tsup.config.ts"), "utf8");

    expect(tsup).toContain('fs.readdir("prisma/migrations"');
    expect(tsup).toContain('path.join("build", "schema-version.json")');
    expect(tsup).toContain("JSON.stringify({ migrations })");
  });

  it("a replica's boot asks for it, and the release step never does", () => {
    const entrypoint = readFileSync(
      resolve(ROOT, "infra/scripts/docker-entrypoint.sh"),
      "utf8",
    );
    const waits = entrypoint
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("node build/wait-for-postgres.js"));

    expect(waits.sort()).toEqual([
      "node build/wait-for-postgres.js",
      "node build/wait-for-postgres.js --require-migrations build/schema-version.json",
    ]);
  });

  it("the smoke test of deploy.yml looks for the refusal's own words", () => {
    const workflow = readFileSync(
      resolve(ROOT, ".github/workflows/deploy.yml"),
      "utf8",
    );

    expect(workflow).toContain('grep -q "não tem a migration"');
    expect(missingMigrationRefusal([NEWEST])).toContain("não tem a migration");
  });
});
