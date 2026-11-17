import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LOCK_RETRIES,
  DEFAULT_LOCK_TIMEOUT_MS,
  loadConcurrentFiles,
  parseConcurrentFile,
  partitionIndexName,
  prebuildSettings,
} from "infra/scripts/online-ddl";
import { bouncerRefusal } from "infra/scripts/release-connection";

/**
 * prisma/concurrent, the release step's online DDL (plano-escala F2-01),
 * before it touches a database: what a file may say, how it says which
 * tables it needs, and the knobs it reads.
 *
 * The whitelist is the safety: the step runs on production's live tables
 * BEFORE the migrations, outside any transaction, so anything but the few
 * statements that are safe there (a concurrent index build or drop, a
 * statistics target, a storage parameter) is refused before a single one
 * runs. The behaviour against a real Postgres (locks, retries, invalid
 * indexes, partitions) is tests/E2E/prebuild-online-ddl.test.ts.
 */
const HEADER = "-- requires-table: delivery_event\n";

describe("a prisma/concurrent file", () => {
  it("reads the concurrent index build with its name, table and definition", () => {
    const { file, errors } = parseConcurrentFile(
      "1_feed.sql",
      `${HEADER}CREATE INDEX CONCURRENTLY IF NOT EXISTS "delivery_event_feed_idx"\n  ON "delivery_event" ("businessId", "createdAt") WHERE "txid" IS NOT NULL;`,
    );

    expect(errors).toEqual([]);
    expect(file?.statements).toEqual([
      {
        kind: "create-index",
        sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "delivery_event_feed_idx" ON "delivery_event" ("businessId", "createdAt") WHERE "txid" IS NOT NULL',
        name: "delivery_event_feed_idx",
        table: "delivery_event",
        unique: false,
        definition: '("businessId", "createdAt") WHERE "txid" IS NOT NULL',
      },
    ]);
  });

  it("accepts each statement of the whitelist", () => {
    const { file, errors } = parseConcurrentFile(
      "2_all.sql",
      [
        HEADER,
        "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON delivery_event USING btree (id);",
        "DROP INDEX CONCURRENTLY IF EXISTS old_idx;",
        'ALTER TABLE delivery_event ALTER COLUMN "businessId" SET STATISTICS 1000;',
        "ALTER TABLE delivery_event SET (autovacuum_vacuum_scale_factor = 0.02);",
        "ALTER TABLE delivery_event RESET (fillfactor);",
        'CREATE STATISTICS IF NOT EXISTS delivery_event_stats (mcv, dependencies) ON "businessId", status FROM delivery_event;',
      ].join("\n"),
    );

    expect(errors).toEqual([]);
    expect(file?.statements.map((statement) => statement.kind)).toEqual([
      "create-index",
      "drop-index",
      "alter-table",
      "alter-table",
      "alter-table",
      "create-statistics",
    ]);
    expect(file?.statements[0]).toMatchObject({ unique: true, name: "a_idx" });
  });

  // The step reads these back from the catalog before running them again
  // (F2-22): each takes the lock of every vacuum and ANALYZE, and the step
  // runs on every release.
  it("reads what each ALTER TABLE leaves in the catalog, so a second run can skip it", () => {
    const { file, errors } = parseConcurrentFile(
      "4_effects.sql",
      [
        HEADER,
        'ALTER TABLE delivery_event ALTER COLUMN "businessId" SET STATISTICS 1000;',
        "ALTER TABLE delivery_event ALTER COLUMN Status SET STATISTICS -1;",
        "ALTER TABLE delivery_event SET (autovacuum_vacuum_scale_factor = 0.02, Toast.Autovacuum_Enabled = 'off');",
        "ALTER TABLE delivery_event RESET (fillfactor, autovacuum_enabled);",
        "ALTER TABLE delivery_event SET (fillfactor = 90 + 0);",
      ].join("\n"),
    );

    expect(errors).toEqual([]);
    expect(
      file?.statements.map((statement) =>
        statement.kind === "alter-table" ? statement.effect : statement.kind,
      ),
    ).toEqual([
      { kind: "statistics", column: "businessId", target: 1000 },
      { kind: "statistics", column: "status", target: -1 },
      {
        kind: "set",
        options: [
          { key: "autovacuum_vacuum_scale_factor", value: "0.02" },
          { key: "toast.autovacuum_enabled", value: "off" },
        ],
      },
      { kind: "reset", keys: ["fillfactor", "autovacuum_enabled"] },
      // Not a plain value: no effect to read, so it simply runs every time.
      null,
    ]);
  });

  it.each([
    [
      "a plain CREATE INDEX (holds the writes)",
      "CREATE INDEX a_idx ON delivery_event (id);",
    ],
    [
      "a CIC without IF NOT EXISTS (fails on the second run)",
      "CREATE INDEX CONCURRENTLY a_idx ON delivery_event (id);",
    ],
    ["a plain DROP INDEX", "DROP INDEX IF EXISTS a_idx;"],
    ["a column change", "ALTER TABLE delivery_event ADD COLUMN x int;"],
    ["a DO block", "DO $$ BEGIN PERFORM 1; END $$;"],
    ["data", "UPDATE delivery_event SET status = 'X';"],
    ["a transaction", "BEGIN;"],
    // One ALTER TABLE may carry several subcommands: a storage parameter
    // must not smuggle in a rewrite under ACCESS EXCLUSIVE.
    [
      "a storage parameter chained to a column rewrite",
      "ALTER TABLE delivery_event SET (fillfactor = 90), ALTER COLUMN code TYPE bigint USING (code::bigint);",
    ],
    [
      "a storage parameter chained to a new checked column",
      "ALTER TABLE delivery_event RESET (fillfactor), ADD COLUMN x int CHECK (x > 0);",
    ],
    [
      "a statistics target chained to another subcommand",
      "ALTER TABLE delivery_event ALTER COLUMN code SET STATISTICS 100, ALTER COLUMN code SET NOT NULL;",
    ],
  ])("refuses %s, and runs nothing of the file", (_case, sql) => {
    const { file, errors } = parseConcurrentFile(
      "3_bad.sql",
      `${HEADER}${sql}`,
    );

    expect(file).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("demands every table it touches up front, so a database without it skips the file", () => {
    const { file, errors } = parseConcurrentFile(
      "4_undeclared.sql",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON route_stop (id);",
    );

    expect(file).toBeNull();
    expect(errors).toEqual([
      "4_undeclared.sql: route_stop não está declarada em -- requires-table",
    ]);
  });

  it("counts a required column's table as declared", () => {
    const { file, errors } = parseConcurrentFile(
      "5_column.sql",
      '-- requires-column: route_stop."deliveryId"\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON route_stop ("deliveryId");',
    );

    expect(errors).toEqual([]);
    expect(file?.requiresTables).toEqual(["route_stop"]);
    expect(file?.requiresColumns).toEqual([
      { table: "route_stop", column: "deliveryId" },
    ]);
  });

  it("refuses ON ONLY: the step builds a partitioned parent's index itself", () => {
    const { errors } = parseConcurrentFile(
      "6_only.sql",
      "-- requires-table: driver_position\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON ONLY driver_position (id);",
    );

    expect(errors).toContain(
      "6_only.sql: escreva ON <tabela>, sem ONLY: o passo faz o ON ONLY e o ATTACH de uma tabela particionada sozinho",
    );
  });

  it("refuses a name Postgres would cut, which the lookup by name would then miss", () => {
    const { errors } = parseConcurrentFile(
      "7_long.sql",
      `${HEADER}CREATE INDEX CONCURRENTLY IF NOT EXISTS ${"x".repeat(64)} ON delivery_event (id);`,
    );

    expect(errors).toEqual([
      `7_long.sql: o nome ${"x".repeat(64)} passa de 63 bytes (o Postgres o cortaria)`,
    ]);
  });

  it("ignores a semicolon inside a literal or a comment", () => {
    const { file, errors } = parseConcurrentFile(
      "8_literal.sql",
      `${HEADER}-- a comment; with a semicolon\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON delivery_event (id) WHERE status <> 'a;b';`,
    );

    expect(errors).toEqual([]);
    expect(file?.statements).toHaveLength(1);
  });

  it("refuses an empty file", () => {
    expect(parseConcurrentFile("9_empty.sql", HEADER).errors).toEqual([
      "9_empty.sql: nenhum comando",
    ]);
  });
});

describe("the directory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trajetto-concurrent-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runs the .sql files in name order and leaves the rest (the README) alone", () => {
    writeFileSync(join(dir, "README.md"), "# not SQL; CREATE TABLE x();");
    writeFileSync(
      join(dir, "20261202_b.sql"),
      `${HEADER}CREATE INDEX CONCURRENTLY IF NOT EXISTS b_idx ON delivery_event (id);`,
    );
    writeFileSync(
      join(dir, "20261201_a.sql"),
      `${HEADER}CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON delivery_event (id);`,
    );

    const { files, errors } = loadConcurrentFiles(dir);

    expect(errors).toEqual([]);
    expect(files.map((file) => file.name)).toEqual([
      "20261201_a.sql",
      "20261202_b.sql",
    ]);
  });

  it("refuses the same index built by two files", () => {
    for (const name of ["1_a.sql", "2_b.sql"]) {
      writeFileSync(
        join(dir, name),
        `${HEADER}CREATE INDEX CONCURRENTLY IF NOT EXISTS same_idx ON delivery_event (id);`,
      );
    }

    expect(loadConcurrentFiles(dir).errors).toEqual([
      "2_b.sql: o índice same_idx já é criado por 1_a.sql",
    ]);
  });

  it("is empty, not an error, when it does not exist", () => {
    expect(loadConcurrentFiles(join(dir, "missing"))).toEqual({
      files: [],
      errors: [],
    });
  });

  it("holds files that all pass the whitelist (the repository's own)", () => {
    expect(loadConcurrentFiles("prisma/concurrent").errors).toEqual([]);
  });
});

describe("a partition's index name", () => {
  it("is the partition and the parent's index", () => {
    expect(partitionIndexName("driver_position_p20261201", "dp_feed_idx")).toBe(
      "driver_position_p20261201_dp_feed_idx",
    );
  });

  it("is cut with a stable hash when too long", () => {
    const name = partitionIndexName(
      "driver_position_v2_p20261201",
      "driver_position_v2_business_driver_recorded_idx",
    );

    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    expect(name).toMatch(/_[0-9a-f]{8}$/);
    expect(
      partitionIndexName(
        "driver_position_v2_p20261201",
        "driver_position_v2_business_driver_recorded_idx",
      ),
    ).toBe(name);
  });
});

describe("the knobs (Environment of trajetto-api-migrate)", () => {
  it("runs by default, with 3 s per lock wait and 20 retries", () => {
    expect(prebuildSettings({})).toEqual({
      enabled: true,
      lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
      lockRetries: DEFAULT_LOCK_RETRIES,
      warnings: [],
    });
    expect([DEFAULT_LOCK_TIMEOUT_MS, DEFAULT_LOCK_RETRIES]).toEqual([3000, 20]);
  });

  it("turns off only on an explicit off (the emergency switch)", () => {
    expect(prebuildSettings({ PREBUILD_ONLINE_DDL: "off" }).enabled).toBe(
      false,
    );
    expect(prebuildSettings({ PREBUILD_ONLINE_DDL: "OFF " }).enabled).toBe(
      false,
    );
    expect(prebuildSettings({ PREBUILD_ONLINE_DDL: "on" }).enabled).toBe(true);
    expect(prebuildSettings({ PREBUILD_ONLINE_DDL: "" }).enabled).toBe(true);
  });

  it("keeps the default on a typo, and says so, instead of stopping a release", () => {
    const settings = prebuildSettings({
      PREBUILD_LOCK_TIMEOUT_MS: "3s",
      PREBUILD_LOCK_RETRIES: "-1",
      PREBUILD_ONLINE_DDL: "desligado",
    });

    expect(settings).toMatchObject({
      enabled: true,
      lockTimeoutMs: 3000,
      lockRetries: 20,
    });
    expect(settings.warnings).toHaveLength(3);
  });

  it("takes valid values", () => {
    expect(
      prebuildSettings({
        PREBUILD_LOCK_TIMEOUT_MS: "1500",
        PREBUILD_LOCK_RETRIES: "5",
      }),
    ).toMatchObject({ lockTimeoutMs: 1500, lockRetries: 5 });
  });
});

describe("the URL the release step runs on", () => {
  it("is the database itself", () => {
    expect(
      bouncerRefusal(
        "postgresql://u:p@trajetto-database:5432/trajetto?schema=public&connection_limit=2",
      ),
    ).toBeNull();
  });

  it.each([
    ["PgBouncer's port", "postgresql://u:p@pgbouncer:6432/trajetto"],
    [
      "Prisma's pgbouncer flag",
      "postgresql://u:p@db:5432/trajetto?pgbouncer=true",
    ],
    ["no URL at all", undefined],
    ["something that is not a URL", "not a url"],
  ])("is refused through %s", (_case, url) => {
    expect(bouncerRefusal(url)).toEqual(expect.any(String));
  });
});
