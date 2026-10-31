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
 * The boot's refusal of a database without the build's last migration. The
 * API image no longer migrates (the release image does, once, before the
 * rollout); this is what keeps a replica from serving a schema older than
 * its build. The wiring into wait-for-postgres, on a real Postgres, is in
 * tests/E2E/schema-guard.test.ts; the image's own refusal, in the smoke test
 * of deploy.yml.
 */
const ROOT = process.cwd();

function fakeClient(tablePresent: boolean, applied: boolean) {
  const queries: Array<{ query: string; values: unknown[] }> = [];

  const client: RawQueryClient = {
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]) {
      queries.push({ query, values });

      return (
        query.includes("to_regclass")
          ? [{ present: tablePresent }]
          : [{ applied }]
      ) as T;
    },
  };

  return { client, queries };
}

const MIGRATION = "20261028140100_import_reversal_progress";

describe("schemaRefusal", () => {
  it("goes ahead when the build's migration is applied", async () => {
    const { client } = fakeClient(true, true);

    expect(await schemaRefusal(client, MIGRATION)).toBeNull();
  });

  it("refuses when it is not, naming it and the image that migrates", async () => {
    const { client } = fakeClient(true, false);
    const refusal = await schemaRefusal(client, MIGRATION);

    expect(refusal).toBe(missingMigrationRefusal(MIGRATION));
    expect(refusal).toContain(MIGRATION);
    expect(refusal).toContain("trajetto-api-migrate");
  });

  it("refuses a database without _prisma_migrations, without querying a missing table", async () => {
    const { client, queries } = fakeClient(false, true);

    expect(await schemaRefusal(client, MIGRATION)).toBe(
      missingMigrationRefusal(MIGRATION),
    );
    expect(queries).toHaveLength(1);
  });

  it("counts only a finished migration that was not rolled back, passing the name as a parameter", async () => {
    const { client, queries } = fakeClient(true, true);

    await schemaRefusal(client, MIGRATION);

    const lookup = queries[1];

    expect(lookup.query).toContain("finished_at IS NOT NULL");
    expect(lookup.query).toContain("rolled_back_at IS NULL");
    expect(lookup.query).toContain("migration_name = $1");
    expect(lookup.query).not.toContain(MIGRATION);
    expect(lookup.values).toEqual([MIGRATION]);
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

  it("reads the migration the build recorded", () => {
    const file = write(JSON.stringify({ latestMigration: MIGRATION }));

    expect(readSchemaVersion(file)).toEqual({ latestMigration: MIGRATION });
  });

  it("accepts the one migration with an empty name", () => {
    const file = write(JSON.stringify({ latestMigration: "20250716112605_" }));

    expect(readSchemaVersion(file).latestMigration).toBe("20250716112605_");
  });

  it.each([
    ["no name", "{}"],
    [
      "not a migration directory",
      JSON.stringify({ latestMigration: "latest" }),
    ],
    ["a path", JSON.stringify({ latestMigration: "../20261028140100_x" })],
    ["not JSON", "20261028140100_x"],
    ["nothing in it", ""],
  ])("refuses a file with %s, naming the file", (_case, content) => {
    const file = write(content);

    expect(() => readSchemaVersion(file)).toThrow(
      `${file} não diz a última migration do build`,
    );
  });

  it("refuses a missing file, naming it", () => {
    box = sandbox();

    const file = `${box.root}/build/schema-version.json`;

    expect(() => readSchemaVersion(file)).toThrow(file);
  });

  it("matches every migration directory name of the repository", () => {
    const names = readdirSync(resolve(ROOT, "prisma/migrations"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(names.length).toBeGreaterThan(100);

    for (const name of names) {
      const file = write(JSON.stringify({ latestMigration: name }));

      expect(readSchemaVersion(file).latestMigration, name).toBe(name);
      box?.dispose();
      box = undefined;
    }
  });
});

describe("where the build records it, and where the boot reads it", () => {
  it("tsup writes build/schema-version.json from the last migration directory", () => {
    const tsup = readFileSync(resolve(ROOT, "tsup.config.ts"), "utf8");

    expect(tsup).toContain('fs.readdir("prisma/migrations"');
    expect(tsup).toContain('path.join("build", "schema-version.json")');
    expect(tsup).toContain("JSON.stringify({ latestMigration })");
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
});
