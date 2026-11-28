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

/**
 * The planner settings of prisma/concurrent (F2-22): a statistics target, a
 * storage parameter, an extended statistics object. The step skips a new
 * database, so a migration makes the same statement there (the E2E
 * template, `yarn dev`, the shadow database), guarded by the catalog so
 * that, where the step already ran, it neither repeats nor waits for the
 * lock of a vacuum. Spelled the same in both, so they cannot drift apart.
 */
function settingsMissingFromMigrations(
  migrations: Migration[],
  files: ConcurrentFile[],
): string[] {
  const code = migrations.map((migration) =>
    codeOf(migration.sql).replace(/\s+/g, " "),
  );

  return files.flatMap((file) =>
    file.statements
      .filter(
        (statement) =>
          statement.kind === "alter-table" ||
          statement.kind === "create-statistics",
      )
      .filter((statement) => !code.some((sql) => sql.includes(statement.sql)))
      .map((statement) => `${file.name}: ${statement.sql}`),
  );
}

describe("planner settings of prisma/concurrent", () => {
  it("are each made by a migration too, word for word", () => {
    const { files, errors } = loadConcurrentFiles(CONCURRENT_DIR);

    expect(errors).toEqual([]);
    expect(settingsMissingFromMigrations(allMigrations(), files)).toEqual([]);
  });

  it("and a setting no migration makes is named", () => {
    const parsed = parseConcurrentFile(
      "20261201000000_stats.sql",
      '-- requires-table: delivery\nALTER TABLE "delivery" ALTER COLUMN "code" SET STATISTICS 500;',
    );

    expect(
      settingsMissingFromMigrations(
        [{ name: "20261201000000_other", sql: "SELECT 1;" }],
        [parsed.file!],
      ),
    ).toEqual([
      '20261201000000_stats.sql: ALTER TABLE "delivery" ALTER COLUMN "code" SET STATISTICS 500',
    ]);
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

/**
 * A column and its index in the SAME release (the owner's decision of
 * 16/11/2026: the whole scale plan ships in one push, F2-03's feed index
 * among it). prisma/concurrent runs before `migrate deploy`, when the
 * column is not there yet, so it skips the file; a plain `CREATE INDEX IF
 * NOT EXISTS` in the migration would then build the index on production's
 * live table under a SHARE lock, every write waiting, and the run would
 * stay green.
 *
 * So the step runs prisma/concurrent again right after the migrations, and
 * the migration builds such an index only on an EMPTY table (a new
 * database: the E2E template, `yarn dev`, Prisma's shadow database), in
 * the form the README shows:
 *
 *   DO $$
 *   BEGIN
 *     IF NOT EXISTS (SELECT 1 FROM "<table>" LIMIT 1) THEN
 *       CREATE INDEX IF NOT EXISTS ...;
 *     END IF;
 *   END $$;
 *
 * With rows, the block does nothing, and the second pass builds the index
 * concurrently. Which columns arrive "in the same release" cannot be read
 * from the repository, so every column some migration adds with ADD COLUMN
 * counts: for one that is long in production, the block is a harmless
 * no-op (the first pass built the index already). And the file must say
 * which of those columns its index reads (`-- requires-column`): without
 * it, the first pass would try the CIC on a column that does not exist yet
 * and fail the release.
 */
const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`(?:(?:"public"|public)\.)?(${IDENT})`;

/** table → the columns some migration adds to it with ADD COLUMN. */
function columnsAddedBy(migrations: Migration[]): Map<string, Set<string>> {
  const added = new Map<string, Set<string>>();
  const alter = new RegExp(
    String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED}([^;]*)`,
    "gi",
  );
  const addColumn = new RegExp(
    String.raw`\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`,
    "gi",
  );

  for (const { sql } of migrations) {
    for (const [, table, rest] of codeOf(sql).matchAll(alter)) {
      for (const [, column] of rest.matchAll(addColumn)) {
        const columns = added.get(unquote(table)) ?? new Set<string>();

        columns.add(unquote(column));
        added.set(unquote(table), columns);
      }
    }
  }

  return added;
}

/** The identifiers an index definition names (string literals left out). */
function identifiersOf(definition: string): Set<string> {
  const names = new Set<string>();
  let rest = definition.replace(/'(?:[^']|'')*'/g, " ");

  rest = rest.replace(/"((?:[^"]|"")+)"/g, (_quoted, name: string) => {
    names.add(name.replace(/""/g, '"'));

    return " ";
  });

  for (const [word] of rest.matchAll(/[A-Za-z_][\w$]*/g)) {
    names.add(word.toLowerCase());
  }

  return names;
}

/** `name@table` of each CREATE INDEX a migration runs only on an empty table. */
function emptyTableIndexes(sql: string): Set<string> {
  const guarded = new Set<string>();
  const guard = new RegExp(
    String.raw`IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(?:ONLY\s+)?${QUALIFIED}\s+LIMIT\s+1\s*\)\s+THEN([\s\S]*?)\bEND\s+IF\b`,
    "gi",
  );

  for (const [, , block] of codeOf(sql).matchAll(
    /\bDO\s+(\$[A-Za-z_]*\$)([\s\S]*?)\1/gi,
  )) {
    for (const [, table, body] of block.matchAll(guard)) {
      for (const index of indexesCreatedBy(body)) {
        if (index.table === unquote(table)) {
          guarded.add(`${index.name}@${index.table}`);
        }
      }
    }
  }

  return guarded;
}

/** What a column and its index in one release would get wrong. */
function sameReleaseProblems(
  migrations: Migration[],
  files: ConcurrentFile[],
): string[] {
  const added = columnsAddedBy(migrations);
  const problems: string[] = [];

  for (const file of files) {
    for (const statement of file.statements) {
      if (statement.kind !== "create-index") continue;

      const addedHere = added.get(statement.table) ?? new Set<string>();
      const declared = file.requiresColumns
        .filter((each) => each.table === statement.table)
        .map((each) => each.column);

      for (const column of identifiersOf(statement.definition)) {
        if (addedHere.has(column) && !declared.includes(column)) {
          problems.push(
            `${file.name}: o índice ${statement.name} lê ${statement.table}.${column}, que uma migration acrescenta (ADD COLUMN): declare -- requires-column: ${statement.table}.${column}`,
          );
        }
      }

      const late = declared.filter((column) => addedHere.has(column));

      if (late.length === 0) continue;

      for (const migration of migrations) {
        if (migration.name <= LAST_MIGRATION_BEFORE_PREBUILD) continue;

        const guarded = emptyTableIndexes(migration.sql);

        for (const index of indexesCreatedBy(migration.sql)) {
          if (index.name !== statement.name) continue;
          if (guarded.has(`${index.name}@${index.table}`)) continue;

          problems.push(
            `${migration.name}: o índice ${index.name} lê ${late.map((column) => `${statement.table}.${column}`).join(", ")}, que pode chegar nesta mesma release: construa-o só com a tabela vazia (IF NOT EXISTS (SELECT 1 FROM "${statement.table}" LIMIT 1), prisma/concurrent/README.md); com linhas, o prisma/concurrent o faz depois das migrations`,
          );
        }
      }
    }
  }

  return problems;
}

describe("a column and its index in one release", () => {
  it("the repository's files declare such columns, and their migrations build only on an empty table", () => {
    const { files, errors } = loadConcurrentFiles(CONCURRENT_DIR);

    expect(errors).toEqual([]);
    expect(sameReleaseProblems(allMigrations(), files)).toEqual([]);
  });
});

describe("the same-release check", () => {
  const file = (sql: string): ConcurrentFile => {
    const parsed = parseConcurrentFile("20261201000000_feed.sql", sql);

    if (!parsed.file) throw new Error(parsed.errors.join("\n"));

    return parsed.file;
  };

  const ADD_TXID = {
    name: "20261201000000_txid",
    sql: 'ALTER TABLE "delivery_event" ADD COLUMN "txid" BIGINT,\nADD COLUMN "other" TEXT;',
  };

  const FEED = file(
    '-- requires-column: delivery_event.txid\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "feed_idx" ON "delivery_event" ("businessId", (COALESCE("txid", 0)), "id");',
  );

  const guardedIndex = (table: string) => ({
    name: "20261201000100_feed",
    sql: [
      "-- With rows, prisma/concurrent builds it after the migrations.",
      "DO $$",
      "BEGIN",
      `  IF NOT EXISTS (SELECT 1 FROM "${table}" LIMIT 1) THEN`,
      '    CREATE INDEX IF NOT EXISTS "feed_idx" ON "delivery_event"("businessId", (COALESCE("txid", 0)), "id");',
      "  END IF;",
      "END $$;",
    ].join("\n"),
  });

  it("refuses the plain build of an index whose column arrives in the same release", () => {
    expect(
      sameReleaseProblems(
        [
          ADD_TXID,
          {
            name: "20261201000100_feed",
            sql: 'CREATE INDEX IF NOT EXISTS "feed_idx" ON "delivery_event"("businessId", (COALESCE("txid", 0)), "id");',
          },
        ],
        [FEED],
      ),
    ).toEqual([
      '20261201000100_feed: o índice feed_idx lê delivery_event.txid, que pode chegar nesta mesma release: construa-o só com a tabela vazia (IF NOT EXISTS (SELECT 1 FROM "delivery_event" LIMIT 1), prisma/concurrent/README.md); com linhas, o prisma/concurrent o faz depois das migrations',
    ]);
  });

  it("accepts the build guarded by an empty table, and only by the index's own table", () => {
    expect(
      sameReleaseProblems([ADD_TXID, guardedIndex("delivery_event")], [FEED]),
    ).toEqual([]);
    expect(
      sameReleaseProblems([ADD_TXID, guardedIndex("route")], [FEED]),
    ).toHaveLength(1);
  });

  it("refuses a file that reads an added column without declaring it", () => {
    const undeclared = file(
      '-- requires-table: delivery_event\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "other_idx" ON "delivery_event" (other) WHERE status = \'txid\';',
    );

    expect(sameReleaseProblems([ADD_TXID], [undeclared])).toEqual([
      "20261201000000_feed.sql: o índice other_idx lê delivery_event.other, que uma migration acrescenta (ADD COLUMN): declare -- requires-column: delivery_event.other",
    ]);
  });

  it("leaves alone the columns that came with their table, and the old history", () => {
    const created = {
      name: "20261201000000_ledger",
      sql: 'CREATE TABLE "ledger" ("id" TEXT NOT NULL, "txid" BIGINT);\nCREATE INDEX IF NOT EXISTS "ledger_idx" ON "ledger"("txid");',
    };
    const ledger = file(
      '-- requires-column: ledger.txid\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "ledger_idx" ON "ledger" ("txid");',
    );

    expect(sameReleaseProblems([created], [ledger])).toEqual([]);
    expect(
      sameReleaseProblems(
        [
          { ...ADD_TXID, name: "20260101000000_txid" },
          {
            name: "20260101000100_feed",
            sql: 'CREATE INDEX IF NOT EXISTS "feed_idx" ON "delivery_event"("txid");',
          },
        ],
        [FEED],
      ),
    ).toEqual([]);
  });
});
