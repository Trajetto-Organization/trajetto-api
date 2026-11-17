import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openReleaseClient } from "infra/scripts/release-connection";
import {
  PARTITION_MAINTENANCE_JOB,
  maintainPartitions,
  partitionMaintenanceJob,
} from "@/jobs/cron/partition-maintenance-job";
import {
  addGrains,
  grainStart,
  partitionName,
  registeredPartitions,
} from "@/shared/database/partitions";
import type { CronJobDefinition } from "@/shared/services/cron-scheduler-service";

/**
 * A code rollback past wave 7 of the scale plan (F2-10), and the way back.
 *
 * From wave 7 on the positions go to the lean trail, driver_position_v2;
 * the image before it reads driver_position only. Two things then have to
 * be true, and docs/deploy.md (section 17) says how to get them:
 *
 *  - the points recorded under the new image come back to the old image's
 *    trail screen through prisma/backfills/driver-position-v2-to-legacy.sql.
 *    `INSERT ... SELECT` as the migration's comment put it does not work:
 *    the legacy id is TEXT NOT NULL with no database default, the ids are
 *    uuid on one side and text on the other, and a day the legacy table has
 *    no partition for refuses the whole statement;
 *  - after a rollback longer than the lookahead, the old image never made
 *    the lean trail's partitions (it does not know the table), and the
 *    roll-forward runs no migration. The nightly job's catch-up sweep, one
 *    minute after the boot, makes them: its last success is from before the
 *    rollback, older than its window. Until then every POST of positions is
 *    a 5xx the app keeps and resends.
 */
const URL = () => process.env.DATABASE_URL as string;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const BACKFILL = resolve(
  process.cwd(),
  "prisma/backfills/driver-position-v2-to-legacy.sql",
);

const lean = registeredPartitions().find(
  (table) => table.table === "driver_position_v2",
)!;

let admin: pg.Client;

/** The file's one statement, without the semicolon that ends it. */
function backfillStatement(): string {
  const code = readFileSync(BACKFILL, "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();

  // One statement: the only semicolon is the last character.
  expect(code.indexOf(";")).toBe(code.length - 1);

  return code.slice(0, -1);
}

async function copyBack(): Promise<number> {
  const result = await admin.query(backfillStatement());

  return result.rowCount ?? 0;
}

interface LeanPoint {
  driverId: string;
  businessId: string;
  routeId: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  battery: number | null;
  recorded_at: Date;
}

async function insertLean(point: LeanPoint): Promise<void> {
  await admin.query(
    `INSERT INTO "driver_position_v2" ("driverId", "businessId", "routeId",
       "latitude", "longitude", "accuracy", "speed", "heading", "battery",
       "recorded_at")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      point.driverId,
      point.businessId,
      point.routeId,
      point.latitude,
      point.longitude,
      point.accuracy,
      point.speed,
      point.heading,
      point.battery,
      point.recorded_at.toISOString(),
    ],
  );
}

async function legacyOf(driverId: string) {
  const { rows } = await admin.query<{
    id: string;
    driverId: string;
    businessId: string;
    routeId: string | null;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    speed: number | null;
    heading: number | null;
    battery: number | null;
    recorded_at: string;
  }>(
    `SELECT "id", "driverId", "businessId", "routeId", "latitude",
            "longitude", "accuracy", "speed", "heading", "battery",
            to_char("recorded_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "recorded_at"
       FROM "driver_position"
      WHERE "driverId" = $1
      ORDER BY "recorded_at"`,
    [driverId],
  );

  return rows;
}

async function exists(name: string): Promise<boolean> {
  const { rows } = await admin.query<{ present: boolean }>(
    "SELECT to_regclass(quote_ident($1)) IS NOT NULL AS present",
    [name],
  );

  return rows[0].present;
}

const today = () => grainStart("day", new Date());

/** An instant of today, `minutes` after midnight (UTC). */
const todayAt = (minutes: number) =>
  new Date(today().getTime() + minutes * 60_000);

beforeAll(async () => {
  admin = await openReleaseClient(URL(), "e2e-driver-position-rollback");

  // The template may be a few days old: the partitions of a night first.
  await maintainPartitions();
}, 60_000);

afterAll(async () => {
  await admin.end();
});

describe("prisma/backfills/driver-position-v2-to-legacy.sql", () => {
  it("is not a migration: migrate deploy must not copy the trail back on every release", () => {
    const migrations = readdirSync(resolve(process.cwd(), "prisma/migrations"));

    expect(migrations.filter((name) => name.includes("to_legacy"))).toEqual([]);
    expect(backfillStatement()).toMatch(/^WITH /);
  });

  it("copies the lean points back with an id and text ids, skips the ones already there, and runs once", async () => {
    const driverId = randomUUID();
    const businessId = randomUUID();
    const routeId = randomUUID();

    const full: LeanPoint = {
      driverId,
      businessId,
      routeId,
      latitude: -23.55,
      longitude: -46.63,
      accuracy: 8.5,
      speed: 42,
      heading: 180,
      battery: 77,
      recorded_at: todayAt(10),
    };

    await insertLean(full);
    await insertLean({
      ...full,
      routeId: null,
      accuracy: null,
      speed: null,
      heading: null,
      battery: null,
      latitude: -23.56,
      recorded_at: todayAt(11),
    });
    // A batch resent across the two images during the rolling deploy: the
    // old one wrote it to the legacy table, the new one to the lean one.
    await insertLean({ ...full, latitude: -23.57, recorded_at: todayAt(12) });
    await admin.query(
      `INSERT INTO "driver_position" ("id", "driverId", "businessId",
         "latitude", "longitude", "recorded_at")
       VALUES ($1, $2, $3, -1, -1, $4)`,
      [randomUUID(), driverId, businessId, todayAt(12).toISOString()],
    );

    const first = await copyBack();
    const second = await copyBack();

    expect([first, second]).toEqual([2, 0]);

    const rows = await legacyOf(driverId);

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.id.length === 36)).toBe(true);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(rows[0]).toMatchObject({
      driverId,
      businessId,
      routeId,
      latitude: -23.55,
      longitude: -46.63,
      accuracy: 8.5,
      speed: 42,
      heading: 180,
      battery: 77,
      recorded_at: todayAt(10).toISOString().slice(0, 23),
    });
    expect(rows[1]).toMatchObject({
      routeId: null,
      accuracy: null,
      speed: null,
      heading: null,
      battery: null,
      latitude: -23.56,
    });
    // The point the old image wrote is kept as it was, not overwritten.
    expect(rows[2]).toMatchObject({ latitude: -1, longitude: -1 });
  });

  it("leaves out a day the legacy trail has no partition for, instead of failing the copy", async () => {
    const driverId = randomUUID();
    const businessId = randomUUID();
    const gone = addGrains("day", today(), -120);
    const leanDay = partitionName(lean, gone);

    await admin.query(
      `CREATE TABLE IF NOT EXISTS "${leanDay}" PARTITION OF "driver_position_v2"
         FOR VALUES FROM ('${gone.toISOString()}') TO ('${addGrains("day", gone, 1).toISOString()}')`,
    );

    const point: LeanPoint = {
      driverId,
      businessId,
      routeId: null,
      latitude: -3.1,
      longitude: -60.02,
      accuracy: null,
      speed: null,
      heading: null,
      battery: null,
      recorded_at: new Date(gone.getTime() + HOUR_MS),
    };

    await insertLean(point);
    await insertLean({ ...point, recorded_at: todayAt(30) });

    expect(await copyBack()).toBe(1);
    expect(await copyBack()).toBe(0);

    const rows = await legacyOf(driverId);

    expect(rows.map((row) => row.recorded_at)).toEqual([
      todayAt(30).toISOString().slice(0, 23),
    ]);

    await admin.query(`DROP TABLE "${leanDay}"`);
  });

  it("copies at most 100,000 points a run, and is repeated until it copies none", async () => {
    const driverId = randomUUID();
    const businessId = randomUUID();

    // 100,001 points of one driver, 5 ms apart, early today.
    await admin.query(
      `INSERT INTO "driver_position_v2" ("driverId", "businessId",
         "latitude", "longitude", "recorded_at")
       SELECT $1::uuid, $2::uuid, -23.5, -46.6,
              $3::timestamp + n * INTERVAL '5 milliseconds'
         FROM generate_series(0, 100000) AS n`,
      [driverId, businessId, todayAt(60).toISOString()],
    );

    const runs: number[] = [];
    for (let run = 0; run < 3; run += 1) runs.push(await copyBack());

    expect(runs).toEqual([100_000, 1, 0]);

    const { rows } = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "driver_position" WHERE "driverId" = $1`,
      [driverId],
    );

    expect(rows[0].count).toBe("100001");
  }, 120_000);
});

describe("the roll-forward after a rollback longer than the lookahead", () => {
  it("gets the lean trail's partitions back from the catch-up sweep, without waiting for 04:10", async () => {
    // The old image ran for more than a week: it made none of these, and
    // the days the migration and the last nights made have passed.
    const days = Array.from({ length: lean.lookahead + 2 }, (_, index) =>
      addGrains("day", today(), index - 1),
    );

    for (const day of days) {
      await admin.query(`DROP TABLE IF EXISTS "${partitionName(lean, day)}"`);
    }

    expect(await exists(partitionName(lean, today()))).toBe(false);

    // Its last success is the night before the rollback.
    await admin.query(
      `INSERT INTO "scheduled_job_execution" ("id", "jobName", "scheduledFor",
         "status", "finishedAt", "leaseExpiresAt", "updated_at")
       VALUES ($1, $2, $3, 'SUCCEEDED', $3, $3, $3)`,
      [
        randomUUID(),
        PARTITION_MAINTENANCE_JOB,
        new Date(Date.now() - 8 * DAY_MS).toISOString(),
      ],
    );

    const { CronSchedulerService } =
      await import("@/shared/services/cron-scheduler-service");
    const scheduler = new (
      CronSchedulerService as unknown as new () => {
        registerJob(definition: CronJobDefinition): void;
        catchUp(now?: Date): Promise<void>;
      }
    )();

    scheduler.registerJob(partitionMaintenanceJob);
    await scheduler.catchUp();

    for (const day of days) {
      expect(await exists(partitionName(lean, day)), day.toISOString()).toBe(
        true,
      );
    }

    // And the lean trail takes today's points again.
    await insertLean({
      driverId: randomUUID(),
      businessId: randomUUID(),
      routeId: null,
      latitude: -23.5,
      longitude: -46.6,
      accuracy: null,
      speed: null,
      heading: null,
      battery: null,
      recorded_at: new Date(),
    });
  }, 120_000);
});
