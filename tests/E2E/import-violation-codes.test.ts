import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The infraction import of the release step, all or nothing.
 *
 * The release step (docker-entrypoint.sh, `release`) runs it strictly: a
 * failure fails the step, and only a success moves `<env>-applied`, which
 * the pipeline never runs again for the same release image. The import
 * skips any table that already has a row, so a batch that failed midway
 * and was only logged left the table short for good while the step
 * reported success. Now every batch goes in one transaction.
 *
 * Run for real here, against this file's migrated database: a trigger makes
 * the inserts fail once a hundred rows are in, as a dropped connection or a
 * bad row would midway through.
 */
const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const script = resolve(
  process.cwd(),
  "infra",
  "scripts",
  "import-violation-codes.ts",
);

const client = createPrismaClient({ log: [] });

afterAll(async () => {
  try {
    await client.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS import_check_boom ON "traffic_violation_code"`,
    );
    await client.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS import_check_boom()`,
    );
  } finally {
    await client.$disconnect();
  }
});

/** The script as the release step runs it, from the repository root. */
function importCodes() {
  const result = spawnSync(process.execPath, [tsx, script], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: 120_000,
  });

  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

const rows = () => client.trafficViolationCode.count();

describe("the infraction import (release step)", () => {
  it("fails and leaves the table empty when a batch fails midway, and the next run fills it", async () => {
    expect(await rows()).toBe(0);

    // Previous batches of the same transaction are visible to the trigger:
    // the third batch (rows 101 to 150) fails.
    await client.$executeRawUnsafe(`
      CREATE FUNCTION import_check_boom() RETURNS trigger AS $$
      BEGIN
        IF (SELECT count(*) FROM "traffic_violation_code") >= 100 THEN
          RAISE EXCEPTION 'import_check: failure injected midway';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    await client.$executeRawUnsafe(`
      CREATE TRIGGER import_check_boom
        BEFORE INSERT ON "traffic_violation_code"
        FOR EACH ROW EXECUTE FUNCTION import_check_boom()`);

    const failed = importCodes();

    expect(failed.status, failed.output).not.toBe(0);
    expect(failed.output).toContain("import_check: failure injected midway");
    expect(await rows()).toBe(0);

    await client.$executeRawUnsafe(
      `DROP TRIGGER import_check_boom ON "traffic_violation_code"`,
    );

    const filled = importCodes();

    expect(filled.status, filled.output).toBe(0);
    expect(await rows()).toBeGreaterThan(200);
  });

  it("does nothing on a table already filled, and still succeeds", async () => {
    const before = await rows();

    expect(before).toBeGreaterThan(200);

    const again = importCodes();

    expect(again.status, again.output).toBe(0);
    expect(again.output).toContain("já possui códigos de infração");
    expect(await rows()).toBe(before);
  });
}, 300_000);
