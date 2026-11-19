import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import { logger } from "@/shared/logging/logger";

import {
  isMissingPartition,
  parsePartitionBound,
  partitionMayStillBeCreated,
  routeOfPing,
  splitByPartition,
  type AcceptedPing,
  type PartitionRange,
} from "@/shared/route/driver-position-rules";

import type {
  IDriverPositionRepository,
  LivePosition,
  PositionWrite,
  RecordedBatch,
  StoredPosition,
} from "./IDriver-position-repository";

const log = logger.child({ component: "driver-position" });

/** A point of the trail, by its key (driverId, recorded_at). */
function trailKey(driverId: string, ms: number): string {
  return `${driverId}|${ms}`;
}

interface PlannedRow {
  driverId: string;
  businessId: string;
  routeId: string | null;
  ping: AcceptedPing;
}

interface BatchPlan {
  /** Every point once, under the first flush that has it. */
  trail: PlannedRow[];
  /** trailKey → the index of that flush. */
  owners: Map<string, number>;
  /** Each driver's newest point of the batch, and whose it is. */
  newest: Map<string, PlannedRow>;
  /** Each driver's flushes with points, in the batch's order. */
  byDriver: Map<string, number[]>;
  /** Each flush's newest instant (ms), null for an empty flush. */
  latest: Array<number | null>;
}

/** What writeBatchMany sends, decided in memory. */
function planBatch(writes: PositionWrite[]): BatchPlan {
  const plan: BatchPlan = {
    trail: [],
    owners: new Map(),
    newest: new Map(),
    byDriver: new Map(),
    latest: [],
  };

  writes.forEach((write, index) => {
    const route = write.routeId
      ? { id: write.routeId, started_at: write.routeStartedAt ?? null }
      : null;

    for (const ping of write.pings) {
      const key = trailKey(write.driverId, ping.recorded_at.getTime());

      if (plan.owners.has(key)) continue;

      plan.owners.set(key, index);
      plan.trail.push({
        driverId: write.driverId,
        businessId: write.businessId,
        // By when the point was recorded, as recordBatch (IDEMP-16).
        routeId: routeOfPing(ping.recorded_at, route),
        ping,
      });
    }

    if (write.pings.length === 0) {
      plan.latest.push(null);
      return;
    }

    // The flush's newest point; of two at one instant, the first.
    const top = write.pings.reduce((a, b) =>
      b.recorded_at > a.recorded_at ? b : a,
    );

    plan.latest.push(top.recorded_at.getTime());
    plan.byDriver.set(write.driverId, [
      ...(plan.byDriver.get(write.driverId) ?? []),
      index,
    ]);

    // The driver's row moves to its newest point of the batch, written as
    // the first flush that reached it has it: the one recordBatch would
    // have let through the "only newer" guard.
    const held = plan.newest.get(write.driverId);

    if (!held || top.recorded_at > held.ping.recorded_at) {
      plan.newest.set(write.driverId, {
        driverId: write.driverId,
        businessId: write.businessId,
        routeId: routeOfPing(top.recorded_at, route),
        ping: top,
      });
    }
  });

  return plan;
}

class DriverPositionRepository implements IDriverPositionRepository {
  private prisma = database;

  async recordBatch({
    driverId,
    businessId,
    routeId,
    routeStartedAt = null,
    pings,
  }: PositionWrite): Promise<RecordedBatch> {
    if (pings.length === 0) return { stored: 0, dropped: 0, advanced: false };

    const owner = {
      driverId,
      businessId,
      route: routeId ? { id: routeId, started_at: routeStartedAt } : null,
    };

    try {
      return { ...(await this.writeBatch(owner, pings)), dropped: 0 };
    } catch (error) {
      if (!isMissingPartition(error)) throw error;

      /**
       * Some point of the flush has no partition (INV-14).
       *
       * The table has no DEFAULT partition on purpose, so that one point
       * failed the whole insert — and the phone, reading a 5xx as transient,
       * would resend the same batch forever. Only now, on the failure path,
       * are the bounds read; the flush that fits stays one transaction.
       */
      const ranges = await this.partitionRanges();
      const { writable, orphaned } = splitByPartition(pings, ranges);

      // The nightly job is late, not the point: keep failing so the phone
      // keeps the batch until the partition exists (see the rule).
      if (
        orphaned.some((ping) => partitionMayStillBeCreated(ping.recorded_at))
      ) {
        throw error;
      }

      log.warn(
        {
          driverId,
          dropped: orphaned.length,
          oldest: orphaned
            .reduce((a, b) => (b.recorded_at < a.recorded_at ? b : a))
            .recorded_at.toISOString(),
        },
        "positions with no partition dropped; the rest of the flush was stored",
      );

      const written =
        writable.length > 0
          ? await this.writeBatch(owner, writable)
          : { stored: 0, advanced: false };

      return { ...written, dropped: orphaned.length };
    }
  }

  /**
   * Every range partition of the trail the flush writes (driver_position_v2,
   * plano-escala F2-10), as pg_get_expr prints it.
   */
  private async partitionRanges(): Promise<PartitionRange[]> {
    const rows = await this.prisma.$queryRaw<{ bound: string | null }[]>`
      SELECT pg_get_expr(c."relpartbound", c."oid") AS "bound"
      FROM "pg_inherits" i
      JOIN "pg_class" c ON c."oid" = i."inhrelid"
      WHERE i."inhparent" = '"driver_position_v2"'::regclass
    `;

    return rows
      .map((row) => (row.bound ? parsePartitionBound(row.bound) : null))
      .filter((range): range is PartitionRange => range !== null);
  }

  /**
   * The trail and the last position, in ONE transaction (INV-14, GAP3-14).
   *
   * They were two independent statements under a comment claiming the same
   * commit: when the second failed, the trail kept points the map never
   * showed. Now a failure of either leaves neither.
   */
  private async writeBatch(
    {
      driverId,
      businessId,
      route,
    }: {
      driverId: string;
      businessId: string;
      route: { id: string; started_at: Date | null } | null;
    },
    pings: AcceptedPing[],
  ): Promise<{ stored: number; advanced: boolean }> {
    // In device time, as writeBatchMany inserts them (stable: of two points
    // at one instant the first in the body still wins). The insert takes a
    // lock on each new key in that order; a flush resent while the group
    // commit wrote the same points in another order could deadlock with it.
    const ordered = [...pings].sort(
      (a, b) => a.recorded_at.getTime() - b.recorded_at.getTime(),
    );

    const insertTrail = this.prisma.driverPosition.createMany({
      data: ordered.map((ping) => ({
        driverId,
        businessId,
        // By when the point was recorded: a backlog from before this
        // departure is not this route's (IDEMP-16).
        routeId: routeOfPing(ping.recorded_at, route),

        latitude: ping.latitude,
        longitude: ping.longitude,

        accuracy: ping.accuracy,
        speed: ping.speed,
        heading: ping.heading,

        battery: ping.battery,

        recorded_at: ping.recorded_at,
      })),
      // (driverId, recorded_at) is the lean trail's primary key (plano-escala
      // F2-10; a unique index on the legacy table since
      // 20260924090800_driver_position_dedupe): a batch resent after a lost
      // response is absorbed (ON CONFLICT DO NOTHING) instead of failing the
      // whole request, and `count` is only what was new.
      skipDuplicates: true,
    });

    /**
     * And the one row the map reads.
     *
     * The newest point of the batch, and only if it is newer than what is
     * already stored. A phone coming out of a dead zone flushes a backlog
     * whose LAST point may still be older than a fix that arrived by another
     * route in the meantime — without the guard the dot would jump backwards,
     * which on a map reads as a truck driving in reverse.
     *
     * Written with the same commit as the trail (the $transaction below): the
     * two disagreeing is a map that shows a driver somewhere their own
     * history says they never were.
     */
    const latest = pings.reduce((newest, ping) =>
      ping.recorded_at > newest.recorded_at ? ping : newest,
    );

    const routeId = routeOfPing(latest.recorded_at, route);

    const upsertLastPosition = this.prisma.$executeRaw`
      INSERT INTO "driver_last_position" (
        "driverId", "businessId", "routeId",
        "latitude", "longitude",
        "accuracy", "speed", "heading", "battery",
        "recorded_at", "updated_at"
      ) VALUES (
        ${driverId}, ${businessId}, ${routeId},
        ${latest.latitude}, ${latest.longitude},
        ${latest.accuracy}, ${latest.speed}, ${latest.heading}, ${latest.battery},
        ${latest.recorded_at}, now()
      )
      ON CONFLICT ("driverId") DO UPDATE SET
        "businessId" = EXCLUDED."businessId",
        "routeId" = EXCLUDED."routeId",
        "latitude" = EXCLUDED."latitude",
        "longitude" = EXCLUDED."longitude",
        "accuracy" = EXCLUDED."accuracy",
        "speed" = EXCLUDED."speed",
        "heading" = EXCLUDED."heading",
        "battery" = EXCLUDED."battery",
        "recorded_at" = EXCLUDED."recorded_at",
        "updated_at" = now()
      WHERE "driver_last_position"."recorded_at" < EXCLUDED."recorded_at"
    `;

    const [{ count }, lastPositionRows] = await this.prisma.$transaction([
      insertTrail,
      upsertLastPosition,
    ]);

    // The upsert's row count is the guard's verdict: 1 when the row was
    // inserted or moved forward, 0 when the stored fix was already newer.
    return { stored: count, advanced: lastPositionRows > 0 };
  }

  /**
   * Many flushes in one transaction (plano-escala F5-18), answered as
   * recordBatch answers each one in turn (IDriverPositionRepository).
   *
   * Three statements whatever the number of flushes, and one commit:
   *
   *  1. the trail, every point of every flush in one INSERT … SELECT FROM
   *     unnest(…) ON CONFLICT DO NOTHING, with the casts written out
   *     (Prisma 7 binds raw parameters untyped). A point two flushes share
   *     is sent once, under the first, so `stored` counts it there, as the
   *     second recordBatch would have found it already stored. RETURNING
   *     names what was new;
   *  2. the drivers' last positions as they are now, FOR UPDATE: what
   *     `advanced` is decided against when a driver has several flushes in
   *     the batch;
   *  3. the last positions, one row per driver (the newest point of its
   *     flushes), in one multi-row upsert under recordBatch's "only newer"
   *     guard. RETURNING names the drivers it moved.
   *
   * Every lock is taken in one order, by driver and then by instant: the
   * trail's keys (the INSERT's ORDER BY), then the last positions (the FOR
   * UPDATE's, which the upsert then finds already held). Two batches on two
   * replicas wait for each other, never in a circle.
   */
  async writeBatchMany(writes: PositionWrite[]): Promise<RecordedBatch[]> {
    const results: RecordedBatch[] = writes.map(() => ({
      stored: 0,
      dropped: 0,
      advanced: false,
    }));

    const plan = planBatch(writes);

    if (plan.trail.length === 0) return results;

    const { trail } = plan;
    const drivers = [...plan.newest.keys()].sort();
    const newest = drivers.map((driverId) => plan.newest.get(driverId)!);

    const insertTrail = this.prisma.$queryRaw<
      Array<{ driverId: string; ms: bigint }>
    >`
      INSERT INTO "driver_position_v2" (
        "driverId", "businessId", "routeId",
        "latitude", "longitude",
        "accuracy", "speed", "heading", "battery",
        "recorded_at"
      )
      SELECT
        p."driverId", p."businessId", p."routeId",
        p."latitude", p."longitude",
        p."accuracy", p."speed", p."heading", p."battery",
        p."at"::timestamptz AT TIME ZONE 'UTC'
      FROM unnest(
        ${trail.map((row) => row.driverId)}::uuid[],
        ${trail.map((row) => row.businessId)}::uuid[],
        ${trail.map((row) => row.routeId)}::uuid[],
        ${trail.map((row) => row.ping.latitude)}::float8[],
        ${trail.map((row) => row.ping.longitude)}::float8[],
        ${trail.map((row) => row.ping.accuracy)}::float8[],
        ${trail.map((row) => row.ping.speed)}::float8[],
        ${trail.map((row) => row.ping.heading)}::float8[],
        ${trail.map((row) => row.ping.battery)}::int2[],
        ${trail.map((row) => row.ping.recorded_at.toISOString())}::text[]
      ) AS p(
        "driverId", "businessId", "routeId",
        "latitude", "longitude",
        "accuracy", "speed", "heading", "battery",
        "at"
      )
      ORDER BY 1, 10
      ON CONFLICT DO NOTHING
      RETURNING
        "driverId"::text AS "driverId",
        floor(extract(epoch FROM "recorded_at") * 1000)::bigint AS "ms"
    `;

    const lockLastPositions = this.prisma.$queryRaw<
      Array<{ driverId: string; ms: bigint }>
    >`
      SELECT
        "driverId",
        floor(extract(epoch FROM "recorded_at") * 1000)::bigint AS "ms"
      FROM "driver_last_position"
      WHERE "driverId" = ANY(${drivers}::text[])
      ORDER BY "driverId"
      FOR UPDATE
    `;

    const upsertLastPositions = this.prisma.$queryRaw<
      Array<{ driverId: string }>
    >`
      INSERT INTO "driver_last_position" (
        "driverId", "businessId", "routeId",
        "latitude", "longitude",
        "accuracy", "speed", "heading", "battery",
        "recorded_at", "updated_at"
      )
      SELECT
        l."driverId", l."businessId", l."routeId",
        l."latitude", l."longitude",
        l."accuracy", l."speed", l."heading", l."battery",
        l."at"::timestamptz AT TIME ZONE 'UTC', now()
      FROM unnest(
        ${drivers}::text[],
        ${newest.map((row) => row.businessId)}::text[],
        ${newest.map((row) => row.routeId)}::text[],
        ${newest.map((row) => row.ping.latitude)}::float8[],
        ${newest.map((row) => row.ping.longitude)}::float8[],
        ${newest.map((row) => row.ping.accuracy)}::float8[],
        ${newest.map((row) => row.ping.speed)}::float8[],
        ${newest.map((row) => row.ping.heading)}::float8[],
        ${newest.map((row) => row.ping.battery)}::int2[],
        ${newest.map((row) => row.ping.recorded_at.toISOString())}::text[]
      ) AS l(
        "driverId", "businessId", "routeId",
        "latitude", "longitude",
        "accuracy", "speed", "heading", "battery",
        "at"
      )
      ORDER BY l."driverId"
      ON CONFLICT ("driverId") DO UPDATE SET
        "businessId" = EXCLUDED."businessId",
        "routeId" = EXCLUDED."routeId",
        "latitude" = EXCLUDED."latitude",
        "longitude" = EXCLUDED."longitude",
        "accuracy" = EXCLUDED."accuracy",
        "speed" = EXCLUDED."speed",
        "heading" = EXCLUDED."heading",
        "battery" = EXCLUDED."battery",
        "recorded_at" = EXCLUDED."recorded_at",
        "updated_at" = now()
      WHERE "driver_last_position"."recorded_at" < EXCLUDED."recorded_at"
      RETURNING "driverId"
    `;

    const [inserted, before, moved] = await this.prisma.$transaction([
      insertTrail,
      lockLastPositions,
      upsertLastPositions,
    ]);

    for (const row of inserted) {
      const owner = plan.owners.get(trailKey(row.driverId, Number(row.ms)));

      if (owner !== undefined) results[owner].stored += 1;
    }

    const stored = new Map(
      before.map((row) => [row.driverId, Number(row.ms)] as const),
    );
    const movedDrivers = new Set(moved.map((row) => row.driverId));

    // `advanced`, flush by flush, as the guard would have answered each in
    // turn: newer than what was stored and than the driver's earlier
    // flushes in the batch. The upsert has the last word: when it kept the
    // stored row (a newer fix was already there), none of them moved it.
    for (const [driverId, indexes] of plan.byDriver) {
      if (!movedDrivers.has(driverId)) continue;

      let current = stored.get(driverId) ?? null;

      for (const index of indexes) {
        const latest = plan.latest[index]!;

        if (current === null || latest > current) {
          results[index].advanced = true;
          current = latest;
        }
      }
    }

    return results;
  }

  /**
   * One row per driver, read by index.
   *
   * This used to be `DISTINCT ON` over the trail. Measured against one day of
   * one tenant — 261.000 rows — that was a sequential scan of the partition
   * plus a 14 MB on-disk sort, 408 ms in the database, to return forty rows:
   * the cost grew with the number of PINGS rather than with the number of
   * drivers, and the ruler puts pings at 670 a second.
   *
   * The driver's name and the truck's plate still come from a join rather than
   * from a denormalised column: a plate copied onto every position row is a
   * plate that is wrong on all of them the moment somebody fixes a typo.
   */
  async listLatestByBusiness(
    businessId: string,
    since: Date,
  ): Promise<LivePosition[]> {
    return this.prisma.$queryRaw<LivePosition[]>(Prisma.sql`
      SELECT
        p."driverId",
        p."routeId",
        p."latitude",
        p."longitude",
        p."accuracy",
        p."speed",
        p."heading",
        p."battery",
        p."recorded_at",
        d."name" AS "driverName",
        v."license_plate" AS "vehiclePlate",
        r."code" AS "routeCode"
      FROM "driver_last_position" p
      LEFT JOIN "driver" d ON d."id" = p."driverId"
      LEFT JOIN "route" r ON r."id" = p."routeId"
      LEFT JOIN "vehicle" v ON v."id" = r."vehicleId"
      WHERE p."businessId" = ${businessId}
        AND p."recorded_at" >= ${since}
      ORDER BY p."recorded_at" DESC
    `);
  }

  async listLastSignals(
    businessId: string,
    driverIds: string[],
  ): Promise<Array<{ driverId: string; recorded_at: Date }>> {
    if (driverIds.length === 0) return [];

    return this.prisma.driverLastPosition.findMany({
      // The company in the where too: a driver id alone is one guess away
      // from another carrier's truck.
      where: { businessId, driverId: { in: driverIds } },
      select: { driverId: true, recorded_at: true },
    });
  }

  async listTrail({
    businessId,
    driverId,
    from,
    to,
    routeId,
    max,
  }: {
    businessId: string;
    driverId: string;
    from: Date;
    to: Date;
    routeId?: string;
    max: number;
  }): Promise<{ recorded: number; points: StoredPosition[] }> {
    // Thinned in Postgres (plan of 02/11/2026, G9): a ten-hour day is 2.400
    // points per driver, and every one of them used to cross the wire to be
    // dropped in Node. The window functions still walk the driver's points
    // through (driverId, recorded_at); only the kept ones come back.
    //
    // The kept positions are downsample's: rn = round(i * stride) for
    // i < max - 1, plus the last. For a position rn the only candidate i is
    // round(rn / stride) (stride > 1 once there are more points than max),
    // so the test below is that rule, in exact numeric arithmetic.
    const ceiling = Math.max(2, max);

    // `businessId` in the where even though `driverId` already implies it.
    // The use case checks the driver belongs to the company; this is the
    // second lock, and the one that holds when somebody adds a caller that
    // forgot the first. Half-open, like the business day: a point at
    // midnight belongs to the day it starts, not to both.
    //
    // Both trails while the legacy one exists (plano-escala F2-10): the
    // lean one (uuid columns, read as text) and the legacy one, which the
    // previous image writes during a rolling deploy and which holds the
    // days before the switch. A batch resent across the two images is in
    // both: DISTINCT ON the instant keeps one, the lean one's. Each side
    // goes down its own (driverId, recorded_at) index; the casts are
    // explicit because Prisma 7 sends the parameters untyped.
    const rows = await this.prisma.$queryRaw<
      Array<StoredPosition & { total: number }>
    >(Prisma.sql`
      WITH "points" AS (
        SELECT DISTINCT ON ("recorded_at")
          "driverId", "routeId", "latitude", "longitude", "accuracy",
          "speed", "heading", "battery", "recorded_at"
        FROM (
          SELECT
            "driverId"::text AS "driverId", "routeId"::text AS "routeId",
            "latitude", "longitude", "accuracy", "speed", "heading",
            "battery", "recorded_at", 0 AS "source"
          FROM "driver_position_v2"
          WHERE "businessId" = ${businessId}::uuid
            AND "driverId" = ${driverId}::uuid
            AND "recorded_at" >= ${from}
            AND "recorded_at" < ${to}
            ${routeId ? Prisma.sql`AND "routeId" = ${routeId}::uuid` : Prisma.empty}
          UNION ALL
          SELECT
            "driverId", "routeId",
            "latitude", "longitude", "accuracy", "speed", "heading",
            "battery", "recorded_at", 1 AS "source"
          FROM "driver_position"
          WHERE "businessId" = ${businessId}::text
            AND "driverId" = ${driverId}::text
            AND "recorded_at" >= ${from}
            AND "recorded_at" < ${to}
            ${routeId ? Prisma.sql`AND "routeId" = ${routeId}::text` : Prisma.empty}
        ) "both"
        ORDER BY "recorded_at", "source"
      ),
      "trail" AS (
        SELECT
          "driverId", "routeId", "latitude", "longitude", "accuracy",
          "speed", "heading", "battery", "recorded_at",
          (row_number() OVER (ORDER BY "recorded_at") - 1)::int AS "rn",
          (count(*) OVER ())::int AS "total"
        FROM "points"
      )
      SELECT
        "driverId", "routeId", "latitude", "longitude", "accuracy",
        "speed", "heading", "battery", "recorded_at", "total"
      FROM "trail"
      WHERE "total" <= ${ceiling}
         OR "rn" = "total" - 1
         OR "rn" = ROUND(
              ROUND("rn" / (("total" - 1)::numeric / ${ceiling - 1}))
              * (("total" - 1)::numeric / ${ceiling - 1})
            )
      ORDER BY "recorded_at" ASC
    `);

    return {
      recorded: rows[0]?.total ?? 0,
      points: rows.map(({ total: _total, ...point }) => point),
    };
  }

  async findLast(
    businessId: string,
    driverId: string,
  ): Promise<StoredPosition | null> {
    // The company in the where: a driver id alone is one guess away from
    // another carrier's truck.
    return this.prisma.driverLastPosition.findFirst({
      where: { driverId, businessId },
      select: {
        driverId: true,
        routeId: true,
        latitude: true,
        longitude: true,
        accuracy: true,
        speed: true,
        heading: true,
        battery: true,
        recorded_at: true,
      },
    });
  }

  async hasDriver(businessId: string, driverId: string): Promise<boolean> {
    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, businessId },
      select: { id: true },
    });

    return driver !== null;
  }
}

export { DriverPositionRepository };
