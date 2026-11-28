import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SCHEMA_DRIFT_ALLOWLIST,
  type DriftAllowance,
} from "./support/schema-drift-allowlist";

/**
 * The drift gate (plano-escala F2-02): the database the migrations build
 * must be the one prisma/schema.prisma describes.
 *
 * The schema is what the client queries; the migrations are what every
 * database really runs. When they part — an `@@index` added to the schema
 * without its migration, a default the migration wrote one way and the
 * schema another, a column left behind — production runs without the index
 * the code was written for, or the next `prisma migrate dev` writes a
 * migration that drops something on purpose there. Nothing caught it: the
 * schema guard only counts migrations by name.
 *
 * `prisma migrate diff --from-config-datasource --to-schema` (Prisma
 * 7.10.1's flags; `--from-migrations` would need a shadow database) from
 * this file's database — a clone of the E2E template: every migration, then
 * infra/sql and prisma/post-deploy — to the schema. Every statement it
 * prints must be in the commented allowlist
 * (support/schema-drift-allowlist.ts); an entry past its date, or one that
 * matches nothing, fails too.
 */
const ROOT = process.cwd();
const PRISMA_CLI = resolve(ROOT, "node_modules/prisma/build/index.js");

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "trajetto-drift-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The SQL that would turn this file's database into `schema`. */
function diff(schema: string): string {
  const output = join(scratch, `diff-${Date.now()}.sql`);

  execFileSync(
    process.execPath,
    [
      PRISMA_CLI,
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      schema,
      "--script",
      "--output",
      output,
    ],
    {
      cwd: ROOT,
      stdio: "pipe",
      env: {
        ...process.env,
        // Nothing leaves the machine: no update check, no telemetry.
        CHECKPOINT_DISABLE: "1",
        PRISMA_HIDE_UPDATE_MESSAGE: "1",
      },
    },
  );

  return readFileSync(output, "utf8");
}

/** One statement per entry: comments out, whitespace collapsed, no `;`. */
function normalize(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const matches = (entry: DriftAllowance, statement: string) =>
  typeof entry.statement === "string"
    ? entry.statement === statement
    : entry.statement.test(statement);

/** Everything wrong between a diff and the allowlist, on `today` (UTC). */
function driftProblems(
  statements: string[],
  allowlist: readonly DriftAllowance[],
  today: string,
): string[] {
  const problems: string[] = [];

  for (const statement of statements) {
    if (!allowlist.some((entry) => matches(entry, statement))) {
      problems.push(`drift fora da lista: ${statement}`);
    }
  }

  for (const entry of allowlist) {
    const name = String(entry.statement);

    if (!entry.why.trim()) problems.push(`entrada sem porquê: ${name}`);

    if (entry.until !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.until)) {
        problems.push(`data inválida (${entry.until}): ${name}`);
      } else if (today > entry.until) {
        problems.push(`entrada vencida em ${entry.until}: ${name}`);
      }
    }

    if (!statements.some((statement) => matches(entry, statement))) {
      problems.push(`entrada sem uso (tire da lista): ${name}`);
    }
  }

  return problems;
}

const today = () => new Date().toISOString().slice(0, 10);

describe("the migrated database against prisma/schema.prisma", () => {
  it("differs only by the allowlist, each entry explained and in date", () => {
    const statements = normalize(diff("prisma/schema.prisma"));

    expect(driftProblems(statements, SCHEMA_DRIFT_ALLOWLIST, today())).toEqual(
      [],
    );
  }, 120_000);

  it("fails an @@index the schema gained without its migration", () => {
    const schema = readFileSync(resolve(ROOT, "prisma/schema.prisma"), "utf8");
    const anchor = '  @@map("provider_quota_day")';

    expect(schema).toContain(anchor);

    const withIndex = join(scratch, "schema.prisma");

    writeFileSync(
      withIndex,
      schema.replace(anchor, `  @@index([used])\n${anchor}`),
    );

    const problems = driftProblems(
      normalize(diff(withIndex)),
      SCHEMA_DRIFT_ALLOWLIST,
      today(),
    );

    expect(problems).toEqual([
      expect.stringMatching(
        /^drift fora da lista: CREATE INDEX "provider_quota_day_used_idx"/,
      ),
    ]);
  }, 120_000);
});

describe("the allowlist check", () => {
  const ENTRY: DriftAllowance = {
    statement: 'DROP TABLE "delivery_event_legacy"',
    why: "the history window keeps the old table until the cleanup",
    until: "2026-12-31",
  };

  it("accepts a listed statement up to its day", () => {
    expect(
      driftProblems([ENTRY.statement as string], [ENTRY], "2026-12-31"),
    ).toEqual([]);
  });

  it("fails an entry past its day", () => {
    expect(
      driftProblems([ENTRY.statement as string], [ENTRY], "2027-01-01"),
    ).toEqual([
      'entrada vencida em 2026-12-31: DROP TABLE "delivery_event_legacy"',
    ]);
  });

  it("fails an entry that matches nothing, and a statement that matches no entry", () => {
    expect(
      driftProblems(
        ['ALTER TABLE "x" ADD COLUMN "y" TEXT'],
        [ENTRY],
        "2026-11-17",
      ),
    ).toEqual([
      'drift fora da lista: ALTER TABLE "x" ADD COLUMN "y" TEXT',
      'entrada sem uso (tire da lista): DROP TABLE "delivery_event_legacy"',
    ]);
  });

  it("reads one statement per entry, without the diff's comments", () => {
    expect(
      normalize(
        '-- DropIndex\nDROP INDEX "a";\n\n-- CreateIndex\nCREATE INDEX "b" ON "t"("c");\n',
      ),
    ).toEqual(['DROP INDEX "a"', 'CREATE INDEX "b" ON "t"("c")']);
  });
});
