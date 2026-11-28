import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The queues' contraction (plano-escala F5-06) is written twice: the
 * migration does it on a database with no company, the post-deploy step on
 * one that serves, once every live process can do without. A constraint
 * one of them forgets stays in that kind of database for good, and the
 * partitioned swap of F5-09 then fails there and nowhere else. So the two
 * lists are the same, read from the files.
 */
const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const MIGRATION = read(
  "prisma/migrations/20261118120000_queue_contract/migration.sql",
);
const STEP = read("prisma/post-deploy/05-queue-contract.sql");

function migrationDrops(): string[] {
  const block = MIGRATION.slice(MIGRATION.indexOf("DO $$"));

  return [
    ...block.matchAll(/DROP CONSTRAINT IF EXISTS "([^"]+)"/g),
    ...block.matchAll(/DROP INDEX IF EXISTS "([^"]+)"/g),
  ]
    .map((match) => match[1])
    .sort();
}

function stepDrops(): string[] {
  return [...STEP.matchAll(/\['(?:constraint|index)', '[a-z_]+', '([^']+)'\]/g)]
    .map((match) => match[1])
    .sort();
}

describe("the queues' contraction", () => {
  it("drops the same ten things in the migration and in the step", () => {
    expect(migrationDrops()).toHaveLength(10);
    expect(stepDrops()).toEqual(migrationDrops());
  });

  it("runs the step's drops only after the readiness check and the keys' backfill", () => {
    const ready = STEP.indexOf("trajetto_queue_swap_ready(");
    const backfill = STEP.indexOf('INSERT INTO "outbox_event_key"');
    const drop = STEP.indexOf("EXECUTE format('ALTER TABLE");

    expect(ready).toBeGreaterThan(0);
    expect(backfill).toBeGreaterThan(ready);
    expect(drop).toBeGreaterThan(backfill);
  });

  it("contracts in the migration only on a database with no company", () => {
    const block = MIGRATION.slice(MIGRATION.indexOf("DO $$"));

    expect(block).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM "business" LIMIT 1\) THEN/,
    );
    expect(MIGRATION).toContain("contract-phase:");
  });
});
