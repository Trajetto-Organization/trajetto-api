import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every lock_timeout the release step sets outlasts deadlock_timeout.
 *
 * A DDL statement that waits for a lock held by autovacuum (SHARE UPDATE
 * EXCLUSIVE, which ADD FOREIGN KEY, DROP CONSTRAINT and every ALTER TABLE
 * conflict with) gets the table only when Postgres cancels the
 * autovacuum, and it does that from the waiter's deadlock check, which
 * runs at deadlock_timeout (1 s by default; this repository never changes
 * it). The two timers start together: with lock_timeout equal to
 * deadlock_timeout they fire in the same wake-up, the lock_timeout error
 * is raised before the cancel is sent, and the autovacuum keeps the table.
 * The foreign keys of delivery_event_part (plano-escala F2-16) retried 30
 * times with lock_timeout 1 s: an autovacuum of "delivery" longer than a
 * minute failed the migration and stopped the release.
 *
 * So a lock_timeout here is a literal longer than the default
 * deadlock_timeout, or computed from current_setting('deadlock_timeout').
 */
const DEFAULT_DEADLOCK_TIMEOUT_MS = 1_000;

const ROOT = resolve(process.cwd(), "prisma");
const DIRECTORIES = ["migrations", "concurrent", "post-deploy"];

function sqlFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);

    if (statSync(path).isDirectory()) return sqlFiles(path);

    return name.endsWith(".sql") ? [path] : [];
  });
}

/** The SQL without its `--` comments, which talk about lock_timeout too. */
function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** A Postgres duration in ms: a bare number is ms, as for lock_timeout. */
function durationMs(literal: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/i.exec(literal.trim());

  if (!match) return Number.NaN;

  const unit = (match[2] ?? "ms").toLowerCase();
  const scale: Record<string, number> = {
    ms: 1,
    s: 1_000,
    min: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  return Number(match[1]) * scale[unit];
}

/** Why each lock_timeout of `sql` fails the rule; empty when none does. */
function shortLockTimeouts(sql: string): string[] {
  const code = withoutComments(sql);
  const problems: string[] = [];

  for (const match of code.matchAll(
    /\bSET\s+(?:LOCAL\s+|SESSION\s+)?lock_timeout\s*(?:=|\bTO\b)\s*'?([^';\s]+)'?/gi,
  )) {
    if (!(durationMs(match[1]) > DEFAULT_DEADLOCK_TIMEOUT_MS)) {
      problems.push(match[0].trim());
    }
  }

  for (const match of code.matchAll(
    /set_config\(\s*'lock_timeout'\s*,\s*([\s\S]+?)\s*,\s*(?:true|false)\s*\)/gi,
  )) {
    const value = match[1];
    const literal = /^'([^']*)'$/.exec(value);

    if (literal) {
      if (!(durationMs(literal[1]) > DEFAULT_DEADLOCK_TIMEOUT_MS)) {
        problems.push(match[0].trim());
      }
    } else if (!/current_setting\(\s*'deadlock_timeout'\s*\)/i.test(value)) {
      problems.push(match[0].trim());
    }
  }

  return problems;
}

describe("shortLockTimeouts", () => {
  it("refuses a lock_timeout no longer than the default deadlock_timeout", () => {
    expect(
      shortLockTimeouts("PERFORM set_config('lock_timeout', '1s', true);"),
    ).toHaveLength(1);
    expect(shortLockTimeouts("SET lock_timeout = '1000ms';")).toHaveLength(1);
    expect(shortLockTimeouts("SET LOCAL lock_timeout = 500;")).toHaveLength(1);
  });

  it("accepts a longer literal, or one computed from deadlock_timeout", () => {
    expect(shortLockTimeouts("SET lock_timeout = '5s';")).toEqual([]);
    expect(shortLockTimeouts("SET LOCAL lock_timeout TO '2s';")).toEqual([]);
    expect(
      shortLockTimeouts(
        "PERFORM set_config('lock_timeout', (floor(extract(epoch FROM current_setting('deadlock_timeout')::interval) * 1000) + 1000)::bigint || 'ms', true);",
      ),
    ).toEqual([]);
  });

  it("ignores what a comment says", () => {
    expect(
      shortLockTimeouts("-- each attempt used SET lock_timeout = '1s'\n"),
    ).toEqual([]);
  });
});

describe("the release step's SQL", () => {
  const files = DIRECTORIES.flatMap((directory) =>
    sqlFiles(join(ROOT, directory)),
  );

  it("is found", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never sets a lock_timeout a blocking autovacuum outlives", () => {
    const offenders = files.flatMap((file) =>
      shortLockTimeouts(readFileSync(file, "utf8")).map(
        (problem) => `${file.slice(ROOT.length + 1)}: ${problem}`,
      ),
    );

    expect(offenders).toEqual([]);
  });
});
