import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import { logger } from "@/shared/logging/logger";

import {
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
  RecordedBatch,
  StoredPosition,
} from "./IDriver-position-repository";

const log = logger.child({ component: "driver-position" });

/**
 * Postgres' refusal of a row no partition covers (SQLSTATE 23514). Prisma
 * surfaces it as an unknown request error, so the message is all there is.
 */
function isMissingPartition(error: unknown): boolean {
  return (
    error instanceof Error &&
    /no partition of relation \\?"?driver_position\\?"? found for row/i.test(
      error.message,
    )
  );
}

class DriverPositionRepository implements IDriverPositionRepository {
  private prisma = database;

  async recordBatch({
    driverId,
    businessId,
    routeId,
    routeStartedAt = null,
    pings,
  }: {
    driverId: string;
    businessId: string;
    routeId: string | null;
    routeStartedAt?: Date | null;
    pings: AcceptedPing[];
  }): Promise<RecordedBatch> {
    if (pings.length === 0) return { stored: 0, dropped: 0 };

    const owner = {
      driverId,
      businessId,
      route: routeId ? { id: routeId, started_at: routeStartedAt } : null,
    };

    try {
      return { stored: await this.writeBatch(owner, pings), dropped: 0 };
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

      return {
        stored:
          writable.length > 0 ? await this.writeBatch(owner, writable) : 0,
        dropped: orphaned.length,
      };
    }
  }

  /** Every range partition of driver_position, as pg_get_expr prints it. */
  private async partitionRanges(): Promise<PartitionRange[]> {
    const rows = await this.prisma.$queryRaw<{ bound: string | null }[]>`
      SELECT pg_get_expr(c."relpartbound", c."oid") AS "bound"
      FROM "pg_inherits" i
      JOIN "pg_class" c ON c."oid" = i."inhrelid"
      WHERE i."inhparent" = '"driver_position"'::regclass
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
  ): Promise<number> {
    const insertTrail = this.prisma.driverPosition.createMany({
      data: pings.map((ping) => ({
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
      // (driverId, recorded_at) is unique since
      // 20260924090800_driver_position_dedupe: a batch resent after a lost
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

    const [{ count }] = await this.prisma.$transaction([
      insertTrail,
      upsertLastPosition,
    ]);

    return count;
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
  }: {
    businessId: string;
    driverId: string;
    from: Date;
    to: Date;
    routeId?: string;
  }): Promise<StoredPosition[]> {
    // `businessId` in the where even though `driverId` already implies it.
    // The use case checks the driver belongs to the company; this is the
    // second lock, and the one that holds when somebody adds a caller that
    // forgot the first.
    const rows = await this.prisma.driverPosition.findMany({
      where: {
        businessId,
        driverId,
        // Half-open, like the business day: a point at midnight belongs to
        // the day it starts, not to both.
        recorded_at: { gte: from, lt: to },
        ...(routeId && { routeId }),
      },
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
      orderBy: { recorded_at: "asc" },
    });

    return rows;
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
