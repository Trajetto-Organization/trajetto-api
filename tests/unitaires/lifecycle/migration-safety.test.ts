import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeViolation,
  migrationsAfter,
  violationsIn,
} from "./support/migration-safety";

/**
 * Expand/contract, enforced (INFRA-05).
 *
 * Migrations run while the previous image still serves — the new task's boot
 * in a start-first rollout, the release job just before it — and again under
 * the old image after an automatic rollback. The history shows what that
 * costs when nothing checks: 20260815120000 and 20260815200000 dropped
 * user.whatsapp_instance_connected and business.ai_analysis_used /
 * ai_analysis_reset_at in the same release that stopped reading them, so
 * every authenticated request an old replica served would have failed with
 * P2022 for the whole rollout, and for good after a rollback. Neither had
 * reached production, so their DROPs were taken out; this test keeps the next
 * one from getting in. The rules and how to write a contract migration are in
 * docs/deploy.md (Migrations), "Expand/contract".
 *
 * LAST_MIGRATION_IN_PRODUCTION is the newest migration the production
 * database has. Migrations up to it are history and cannot be edited (their
 * checksums are applied); everything after it has to be safe for the image
 * that is serving now. BUMP IT after every production release, to the last
 * migration that release shipped — otherwise a table created in that release
 * still counts as "new" and a DROP on it would pass.
 */
const LAST_MIGRATION_IN_PRODUCTION = "20260808130000_harden_auth_sessions";

const MIGRATIONS_DIR = resolve(process.cwd(), "prisma/migrations");

function violations(...files: Array<[name: string, sql: string]>) {
  return violationsIn(files.map(([name, sql]) => ({ name, sql }))).map((violation) => ({
    rule: violation.rule,
    target: violation.target,
  }));
}

describe("the migrations of this repository", () => {
  it("name a production baseline that exists", () => {
    expect(existsSync(resolve(MIGRATIONS_DIR, LAST_MIGRATION_IN_PRODUCTION))).toBe(true);
  });

  it("are all safe for the release that is serving while they run", () => {
    const found = violationsIn(migrationsAfter(MIGRATIONS_DIR, LAST_MIGRATION_IN_PRODUCTION));

    expect(found.map(describeViolation)).toEqual([]);
  });
});

describe("the expand/contract check", () => {
  describe("on what the previous release reads or writes", () => {
    it("refuses dropping a column", () => {
      expect(
        violations(["1_a", 'ALTER TABLE "user" DROP COLUMN "whatsapp_instance_connected";']),
      ).toEqual([{ rule: "DROP COLUMN", target: "user" }]);
    });

    it("accepts it in the contract phase, with the reason written down", () => {
      expect(
        violations([
          "1_a",
          '-- contract-phase: 2026.10 stopped reading it\nALTER TABLE "user" DROP COLUMN "x";',
        ]),
      ).toEqual([]);
    });

    it("does not take an empty marker for a reason", () => {
      expect(violations(["1_a", '-- contract-phase:\nALTER TABLE "user" DROP COLUMN "x";'])).toHaveLength(1);
    });

    it("refuses what harden_auth_sessions did: delete, rename, and a required column with no default", () => {
      expect(
        violations([
          "1_harden",
          [
            'DELETE FROM "refresh_token";',
            'ALTER TABLE "refresh_token" RENAME COLUMN "refresh_token" TO "token_hash";',
            'ALTER TABLE "refresh_token" ADD COLUMN "jti" TEXT NOT NULL,',
            '  ADD COLUMN "family_id" TEXT NOT NULL;',
          ].join("\n"),
        ]),
      ).toEqual([
        { rule: "DELETE FROM", target: "refresh_token" },
        { rule: "RENAME COLUMN", target: "refresh_token" },
        { rule: "ADD COLUMN ... NOT NULL without DEFAULT", target: "refresh_token" },
      ]);
    });

    it("accepts a required column that has a default, and any nullable one", () => {
      expect(
        violations([
          "1_a",
          'ALTER TABLE "business" ADD COLUMN "used" INTEGER NOT NULL DEFAULT 0,\n  ADD COLUMN "price" DECIMAL(10,2);',
        ]),
      ).toEqual([]);
    });

    it("refuses retyping, tightening and renaming a table", () => {
      expect(
        violations([
          "1_a",
          [
            'ALTER TABLE "fuel" ALTER COLUMN "liters" SET DATA TYPE DECIMAL(10,3);',
            'ALTER TABLE "fine" ALTER COLUMN "businessId" SET NOT NULL;',
            'ALTER TABLE "vehicle" RENAME TO "vehicles";',
            'TRUNCATE TABLE "activity";',
            'DROP TABLE "kanban_card";',
          ].join("\n"),
        ]),
      ).toEqual([
        { rule: "ALTER COLUMN ... TYPE", target: "fuel" },
        { rule: "SET NOT NULL", target: "fine" },
        { rule: "RENAME TO", target: "vehicle" },
        { rule: "TRUNCATE", target: "activity" },
        { rule: "DROP TABLE", target: "kanban_card" },
      ]);
    });

    it("refuses a new enum value unless it says no running image reads it", () => {
      expect(violations(["1_a", `ALTER TYPE "Role" ADD VALUE 'AUDITOR';`])).toEqual([
        { rule: "ALTER TYPE ... ADD VALUE", target: "Role" },
      ]);

      expect(
        violations([
          "1_a",
          `-- enum-expand: nothing writes AUDITOR before 2026.11\nALTER TYPE "Role" ADD VALUE 'AUDITOR';`,
        ]),
      ).toEqual([]);
    });

    it("refuses making a column optional unless it says nothing writes NULL yet", () => {
      // The previous client reads the column as required: the first NULL the
      // new release writes fails its reads of that row (P2032).
      expect(
        violations(["1_a", 'ALTER TABLE "delivery" ALTER COLUMN "driverId" DROP NOT NULL;']),
      ).toEqual([{ rule: "DROP NOT NULL", target: "delivery" }]);

      expect(
        violations([
          "1_a",
          '-- nullable-expand: nothing writes a NULL driverId before 2026.11\nALTER TABLE "delivery" ALTER COLUMN "driverId" DROP NOT NULL;',
        ]),
      ).toEqual([]);
    });

    it("looks inside DO blocks, where the target cannot be told", () => {
      expect(
        violations(["1_a", `DO $$ BEGIN EXECUTE 'ALTER TABLE "user" DROP COLUMN "x"'; END $$;`]),
      ).toEqual([{ rule: "DROP COLUMN", target: "?" }]);
    });
  });

  describe("on what the previous release has never seen", () => {
    it("accepts tightening a table created after the baseline", () => {
      expect(
        violations(
          ["1_create", 'CREATE TABLE "delivery_event" ("id" TEXT NOT NULL, "businessId" TEXT);'],
          ["2_tighten", 'ALTER TABLE "delivery_event" ALTER COLUMN "businessId" SET NOT NULL;'],
        ),
      ).toEqual([]);
    });

    it("accepts a delete on one, aliased, as the driver_position dedupe does", () => {
      expect(
        violations(
          ["1_create", 'CREATE TABLE "driver_position" ("id" BIGINT);'],
          [
            "2_dedupe",
            'DELETE FROM "driver_position" AS later USING "driver_position" AS earlier WHERE later."id" > earlier."id";',
          ],
        ),
      ).toEqual([]);
    });

    it("accepts making a column optional on a table created after the baseline", () => {
      expect(
        violations(
          ["1_create", 'CREATE TABLE "delivery_event" ("id" TEXT NOT NULL, "reportedById" TEXT NOT NULL);'],
          ["2_loosen", 'ALTER TABLE "delivery_event" ALTER COLUMN "reportedById" DROP NOT NULL;'],
        ),
      ).toEqual([]);
    });

    it("accepts a new value on an enum created after the baseline", () => {
      expect(
        violations(
          ["1_create", `CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'COMPLETED');`],
          ["2_add", `ALTER TYPE "ImportStatus" ADD VALUE IF NOT EXISTS 'IN_PROGRESS' BEFORE 'COMPLETED';`],
        ),
      ).toEqual([]);
    });

    it("does not count a table dropped and then re-created as new", () => {
      expect(
        violations(["1_a", 'DROP TABLE "notification";\nCREATE TABLE "notification" ("id" TEXT);']),
      ).toEqual([{ rule: "DROP TABLE", target: "notification" }]);
    });
  });

  describe("on what is not a statement", () => {
    it("ignores comments and string literals", () => {
      expect(
        violations([
          "1_a",
          `-- ALTER TABLE "user" DROP COLUMN "x";\n/* DROP TABLE "user"; */\nCOMMENT ON TABLE "user" IS 'we DROP COLUMN x later';`,
        ]),
      ).toEqual([]);
    });

    it("is not thrown off by an apostrophe in a comment", () => {
      expect(
        violations(["1_a", `-- the previous image's client\nALTER TABLE "user" DROP COLUMN "x";`]),
      ).toEqual([{ rule: "DROP COLUMN", target: "user" }]);
    });

    it("accepts renaming an index, which the client never names", () => {
      expect(violations(["1_a", 'ALTER INDEX "claim_idx_new" RENAME TO "claim_idx";'])).toEqual([]);
    });
  });
});
