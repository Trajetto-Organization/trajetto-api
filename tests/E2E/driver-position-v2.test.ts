import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The lean GPS trail, driver_position_v2 (plano-escala F2-10), on a real
 * Postgres: what each point costs on disk, and what the table no longer
 * carries.
 *
 * The trail is the one table that grows with time (about 2.400 points per
 * driver in a ten-hour day). The legacy table spent about 565 bytes a point
 * on three indexes and a uuid nobody reads; the plan's budget for the lean
 * one is 270. Measured the way production fills it: flushes of 20 points,
 * one per driver in turn across a fleet, so the primary key
 * (driverId, recorded_at) takes its inserts all over the index, page splits
 * included, as it does at 8 a.m. — not one driver's points in a row, which
 * would pack the index tighter than reality.
 */
const prisma = createPrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

/** Today's partition of the lean trail, as the migration named it. */
function todaysPartition(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  return `driver_position_v2_${day}`;
}

describe("the lean trail", () => {
  it("keeps only what the trail is read by: no id, no created_at, no index by company", async () => {
    const columns = await prisma.$queryRaw<
      Array<{ column_name: string; data_type: string }>
    >`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'driver_position_v2'
      ORDER BY column_name
    `;
    const types = Object.fromEntries(
      columns.map((column) => [column.column_name, column.data_type]),
    );

    expect(types).not.toHaveProperty("id");
    expect(types).not.toHaveProperty("created_at");
    expect(types).toMatchObject({
      driverId: "uuid",
      businessId: "uuid",
      routeId: "uuid",
    });

    const indexes = await prisma.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i
      WHERE i.indrelid = 'driver_position_v2'::regclass
    `;

    // The primary key alone: the point IS (driverId, recorded_at).
    expect(indexes.map((index) => index.definition)).toEqual([
      `CREATE UNIQUE INDEX driver_position_v2_pkey ON ONLY public.driver_position_v2 USING btree ("driverId", recorded_at)`,
    ]);
  });

  it("is partitioned by day, with today's partition ready before the nightly job", async () => {
    const [row] = await prisma.$queryRaw<Array<{ present: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'driver_position_v2'::regclass
          AND c.relname = ${todaysPartition()}
      ) AS present
    `;

    expect(row.present).toBe(true);
  });

  it("stores a point in at most 270 bytes, index included, filled as a fleet fills it", async () => {
    // 200 drivers of three companies, 30 flushes of 20 points each (15 s
    // apart), flush after flush across the fleet: 120.000 points in
    // today's partition, from 01:00 UTC. One statement, so the fleet's
    // temporary table lives in the session that reads it. This file's
    // database is its own clone: nothing else writes the partition.
    await prisma.$executeRawUnsafe(`
      DO $$
      DECLARE f int;
      BEGIN
        CREATE TEMP TABLE e2e_fleet ON COMMIT DROP AS
        SELECT gen_random_uuid() AS d,
               (ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()])[1 + (n % 3)] AS b,
               gen_random_uuid() AS r
        FROM generate_series(1, 200) n;

        FOR f IN 0..29 LOOP
          INSERT INTO driver_position_v2
            ("driverId", "businessId", "routeId", latitude, longitude,
             accuracy, speed, heading, battery, recorded_at)
          SELECT d, b, r, -23.5 + random(), -46.6 + random(),
                 5 + random() * 20, random() * 80, random() * 360, 80,
                 date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 hour'
                   + ((f * 20 + p) * interval '15 seconds')
          FROM e2e_fleet CROSS JOIN generate_series(0, 19) p;
        END LOOP;
      END $$
    `);

    const partition = todaysPartition();
    const [measured] = await prisma.$queryRawUnsafe<
      Array<{ points: number; bytes: number }>
    >(
      `SELECT count(*)::int AS points,
              pg_total_relation_size('"${partition}"'::regclass)::float8 AS bytes
       FROM "${partition}"`,
    );

    expect(measured.points).toBeGreaterThanOrEqual(120_000);

    const perPoint = measured.bytes / measured.points;

    expect(perPoint, `${Math.round(perPoint)} B por ponto`).toBeLessThan(270);
  }, 120_000);
});
