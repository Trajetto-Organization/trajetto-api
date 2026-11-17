import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadConcurrentFiles,
  parseConcurrentFile,
  type ConcurrentFile,
} from "infra/scripts/online-ddl";
import { HOT_TABLES } from "@/shared/health/metrics-queries";

/**
 * The "build the index first by hand" recipe of the migrations, held to
 * what Postgres and `prisma migrate deploy` actually allow (W4-DI-02).
 *
 * On a database with volume a plain CREATE INDEX holds a SHARE lock on the
 * table (every write waits) for the whole build, and lock_timeout only bounds
 * the wait for the lock. So a migration that adds an index to a hot table
 * says: build it first with CREATE INDEX CONCURRENTLY IF NOT EXISTS and this
 * name; this statement then does nothing. When the index reads columns the
 * same migration adds, that recipe only works if the operator first creates
 * the types and the columns by hand too — and then the migration must not
 * fail on them: a bare CREATE TYPE answers 42710 (`already exists`), the
 * deploy stops, and every later migration is blocked until a manual
 * `prisma migrate resolve`.
 *
 * Only this batch's migrations (from 20261102120000), which no lasting
 * database has applied yet: the older ones are history and cannot change.
 */
const FIRST_MIGRATION_OF_THE_BATCH = "20261102120000";

const MIGRATIONS_DIR = resolve(process.cwd(), "prisma/migrations");

interface Migration {
  name: string;
  sql: string;
}

function batch(): Migration[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name >= FIRST_MIGRATION_OF_THE_BATCH,
    )
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(
        join(MIGRATIONS_DIR, entry.name, "migration.sql"),
        "utf8",
      ),
    }));
}

function commentOf(sql: string): string {
  return sql
    .split(/\r?\n/)
    .filter((line) => /^\s*--/.test(line))
    .map((line) => line.replace(/^\s*--\s?/, ""))
    .join("\n");
}

function codeOf(sql: string): string {
  return sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}

/** The SQL outside the DO blocks that swallow `duplicate_object`. */
function outsideIdempotentBlocks(code: string): string {
  return code.replace(/DO\s+\$\$[\s\S]*?\$\$\s*;?/gi, (block) =>
    /EXCEPTION\s+WHEN\s+duplicate_object\s+THEN\s+NULL/i.test(block)
      ? ""
      : block,
  );
}

/** What stands between the documented recipe and a clean deploy. */
function recipeProblems({ name, sql }: Migration): string[] {
  const comment = commentOf(sql);

  if (!/CONCURRENTLY/.test(comment)) return [];

  const code = codeOf(sql);
  const problems: string[] = [];

  if (/\bCREATE\s+TYPE\b/i.test(outsideIdempotentBlocks(code))) {
    problems.push(
      `${name}: CREATE TYPE fora de um DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL`,
    );
  }

  const bareAddColumn = /\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS\b)/i;

  if (bareAddColumn.test(code)) {
    problems.push(`${name}: ADD COLUMN sem IF NOT EXISTS`);
  }

  // The recipe names every step it needs, in order: the operator follows
  // the comment, not the code.
  if (/\bCREATE\s+TYPE\b/i.test(code) && !/CREATE TYPE/.test(comment)) {
    problems.push(`${name}: o roteiro não diz para criar os tipos antes`);
  }

  if (
    /\bADD\s+COLUMN\b/i.test(code) &&
    !/ADD COLUMN IF NOT EXISTS/.test(comment)
  ) {
    problems.push(`${name}: o roteiro não diz para criar as colunas antes`);
  }

  return problems;
}

describe("the pre-build recipe of this batch's migrations", () => {
  it("can be followed on a database with volume and still deploy clean", () => {
    expect(batch().flatMap(recipeProblems)).toEqual([]);
  });
});

describe("the recipe check", () => {
  const RECIPE = [
    "-- On a database with volume, build it first by hand with",
    "-- CREATE INDEX CONCURRENTLY IF NOT EXISTS and this name.",
  ].join("\n");

  it("refuses a bare CREATE TYPE and a bare ADD COLUMN under the recipe", () => {
    expect(
      recipeProblems({
        name: "1_a",
        sql: [
          RECIPE,
          `CREATE TYPE "Kind" AS ENUM ('A');`,
          `ALTER TABLE "delivery" ADD COLUMN "kind" "Kind";`,
          `CREATE INDEX IF NOT EXISTS "i" ON "delivery" ("kind");`,
        ].join("\n"),
      }),
    ).toEqual([
      "1_a: CREATE TYPE fora de um DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL",
      "1_a: ADD COLUMN sem IF NOT EXISTS",
      "1_a: o roteiro não diz para criar os tipos antes",
      "1_a: o roteiro não diz para criar as colunas antes",
    ]);
  });

  it("accepts the idempotent form with the whole recipe written down", () => {
    expect(
      recipeProblems({
        name: "1_a",
        sql: [
          RECIPE,
          "-- First CREATE TYPE and ADD COLUMN IF NOT EXISTS, as below.",
          "DO $$ BEGIN",
          `  CREATE TYPE "Kind" AS ENUM ('A');`,
          "EXCEPTION WHEN duplicate_object THEN NULL;",
          "END $$;",
          `ALTER TABLE "delivery" ADD COLUMN IF NOT EXISTS "kind" "Kind";`,
          `CREATE INDEX IF NOT EXISTS "i" ON "delivery" ("kind");`,
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("leaves alone a migration with no recipe", () => {
    expect(
      recipeProblems({
        name: "1_a",
        sql: `CREATE TYPE "Kind" AS ENUM ('A');\nALTER TABLE "x" ADD COLUMN "k" "Kind";`,
      }),
    ).toEqual([]);
  });
});

/**
 * From the release that brought prisma/concurrent (plano-escala F2-01) on,
 * the recipe is not a comment any more: an index on a hot table is built
 * by a prisma/concurrent file, with CREATE INDEX CONCURRENTLY, BEFORE
 * `migrate deploy`, and the migration keeps `CREATE INDEX IF NOT EXISTS`
 * with the same name, which finds it and does nothing (and still builds it
 * on a new database, where the table is empty). A migration of this era
 * that indexes a hot table without the file would hold every write on it
 * for the whole build; a file without the migration would leave the index
 * out of the history that `migrate diff` and the E2E template read.
 *
 * Hot = HOT_TABLES (src/shared/health/metrics-queries.ts), the tables the
 * scale plan watches. Only migrations after the last one of the batch
 * before F2-01: the older ones are history.
 */
const LAST_MIGRATION_BEFORE_PREBUILD = "20261116120000_provider_quota_day";

const CONCURRENT_DIR = resolve(process.cwd(), "prisma/concurrent");

const INDEX_NAME = String.raw`("(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;

function unquote(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1) : name.toLowerCase();
}

interface IndexStatement {
  name: string;
  table: string;
  ifNotExists: boolean;
}

/** The CREATE INDEX statements of a migration, comments left out. */
function indexesCreatedBy(sql: string): IndexStatement[] {
  const pattern = new RegExp(
    String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?${INDEX_NAME}\s+ON\s+(?:ONLY\s+)?${INDEX_NAME}`,
    "gi",
  );

  return [...codeOf(sql).matchAll(pattern)].map((match) => ({
    ifNotExists: !!match[1],
    name: unquote(match[2]),
    table: unquote(match[3]),
  }));
}

function indexesDroppedBy(sql: string): string[] {
  const pattern = new RegExp(
    String.raw`DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?IF\s+EXISTS\s+${INDEX_NAME}`,
    "gi",
  );

  return [...codeOf(sql).matchAll(pattern)].map((match) => unquote(match[1]));
}

function allMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(
        join(MIGRATIONS_DIR, entry.name, "migration.sql"),
        "utf8",
      ),
    }));
}

/** What the prisma/concurrent files build and drop. */
function concurrentIndexes(files: ConcurrentFile[]): {
  created: Map<string, string>;
  dropped: Map<string, string>;
} {
  const created = new Map<string, string>();
  const dropped = new Map<string, string>();

  for (const file of files) {
    for (const statement of file.statements) {
      if (statement.kind === "create-index") {
        created.set(statement.name, file.name);
      }
      if (statement.kind === "drop-index") {
        dropped.set(statement.name, file.name);
      }
    }
  }

  return { created, dropped };
}

/** What stands between the migrations, the hot tables and prisma/concurrent. */
function prebuildProblems(
  migrations: Migration[],
  files: ConcurrentFile[],
  hot: readonly string[],
): string[] {
  const { created, dropped } = concurrentIndexes(files);
  const problems: string[] = [];

  for (const migration of migrations) {
    if (migration.name <= LAST_MIGRATION_BEFORE_PREBUILD) continue;

    for (const index of indexesCreatedBy(migration.sql)) {
      if (!hot.includes(index.table)) continue;

      if (!created.has(index.name)) {
        problems.push(
          `${migration.name}: o índice ${index.name} da tabela quente ${index.table} precisa de um arquivo em prisma/concurrent`,
        );
      }

      if (!index.ifNotExists) {
        problems.push(
          `${migration.name}: CREATE INDEX ${index.name} sem IF NOT EXISTS (não vira no-op depois do prisma/concurrent)`,
        );
      }
    }
  }

  const everyCreate = new Set(
    migrations.flatMap((migration) =>
      indexesCreatedBy(migration.sql)
        .filter((index) => index.ifNotExists)
        .map((index) => index.name),
    ),
  );
  const everyDrop = new Set(
    migrations.flatMap((migration) => indexesDroppedBy(migration.sql)),
  );

  for (const [name, file] of created) {
    if (!everyCreate.has(name)) {
      problems.push(
        `${file}: o índice ${name} não tem CREATE INDEX IF NOT EXISTS numa migration`,
      );
    }
  }

  for (const [name, file] of dropped) {
    if (!everyDrop.has(name)) {
      problems.push(
        `${file}: o DROP de ${name} não tem DROP INDEX IF EXISTS numa migration`,
      );
    }
  }

  return problems;
}

describe("indexes on hot tables, from prisma/concurrent on", () => {
  it("are built by prisma/concurrent, and every file there is in a migration", () => {
    const { files, errors } = loadConcurrentFiles(CONCURRENT_DIR);

    expect(errors).toEqual([]);
    expect(prebuildProblems(allMigrations(), files, HOT_TABLES)).toEqual([]);
  });

  it("knows where the batch before it ended", () => {
    expect(
      allMigrations().some(
        (migration) => migration.name === LAST_MIGRATION_BEFORE_PREBUILD,
      ),
    ).toBe(true);
  });
});

describe("the hot-table check", () => {
  const HOT = ["delivery_event"];

  const file = (sql: string): ConcurrentFile => {
    const parsed = parseConcurrentFile("20261201000000_feed.sql", sql);

    if (!parsed.file) throw new Error(parsed.errors.join("\n"));

    return parsed.file;
  };

  const CIC = file(
    '-- requires-table: delivery_event\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "feed_idx" ON "delivery_event" ("id");',
  );

  it("refuses a new index on a hot table without its prisma/concurrent file", () => {
    expect(
      prebuildProblems(
        [
          {
            name: "20261201000000_feed",
            sql: 'CREATE INDEX IF NOT EXISTS "feed_idx" ON "delivery_event"("id");',
          },
        ],
        [],
        HOT,
      ),
    ).toEqual([
      "20261201000000_feed: o índice feed_idx da tabela quente delivery_event precisa de um arquivo em prisma/concurrent",
    ]);
  });

  it("refuses the migration's CREATE INDEX without IF NOT EXISTS", () => {
    expect(
      prebuildProblems(
        [
          {
            name: "20261201000000_feed",
            sql: 'CREATE INDEX "feed_idx" ON "delivery_event"("id");',
          },
        ],
        [CIC],
        HOT,
      ),
    ).toEqual([
      "20261201000000_feed: CREATE INDEX feed_idx sem IF NOT EXISTS (não vira no-op depois do prisma/concurrent)",
      "20261201000000_feed.sql: o índice feed_idx não tem CREATE INDEX IF NOT EXISTS numa migration",
    ]);
  });

  it("refuses a prisma/concurrent index or drop that no migration declares", () => {
    const drop = file("DROP INDEX CONCURRENTLY IF EXISTS old_idx;");

    expect(prebuildProblems([], [CIC, drop], HOT)).toEqual([
      "20261201000000_feed.sql: o índice feed_idx não tem CREATE INDEX IF NOT EXISTS numa migration",
      "20261201000000_feed.sql: o DROP de old_idx não tem DROP INDEX IF EXISTS numa migration",
    ]);
  });

  it("accepts the pair, and leaves cold tables and the old history alone", () => {
    expect(
      prebuildProblems(
        [
          {
            name: "20261201000000_feed",
            sql: '-- built first by prisma/concurrent\nCREATE INDEX IF NOT EXISTS "feed_idx" ON "delivery_event"("id");',
          },
          {
            name: "20261201000100_cold",
            sql: 'CREATE INDEX "x_idx" ON "vehicle"("id");',
          },
          {
            name: "20260101000000_old",
            sql: 'CREATE INDEX "old_idx" ON "delivery_event"("id");',
          },
        ],
        [CIC],
        HOT,
      ),
    ).toEqual([]);
  });
});
