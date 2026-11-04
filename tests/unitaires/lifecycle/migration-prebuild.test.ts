import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

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
