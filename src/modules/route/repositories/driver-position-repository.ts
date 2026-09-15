import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import type { AcceptedPing } from "@/shared/route/driver-position-rules";

import type {
  IDriverPositionRepository,
  LivePosition,
  StoredPosition,
} from "./IDriver-position-repository";

class DriverPositionRepository implements IDriverPositionRepository {
  private prisma = database;

  async recordBatch({
    driverId,
    businessId,
    routeId,
    pings,
  }: {
    driverId: string;
    businessId: string;
    routeId: string | null;
    pings: AcceptedPing[];
  }): Promise<number> {
    if (pings.length === 0) return 0;

    const { count } = await this.prisma.driverPosition.createMany({
      data: pings.map((ping) => ({
        driverId,
        businessId,
        routeId,

        latitude: ping.latitude,
        longitude: ping.longitude,

        accuracy: ping.accuracy,
        speed: ping.speed,
        heading: ping.heading,

        battery: ping.battery,

        recorded_at: ping.recorded_at,
      })),
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
     * Written with the same commit as the trail: the two disagreeing is a map
     * that shows a driver somewhere their own history says they never were.
     */
    const latest = pings.reduce((newest, ping) =>
      ping.recorded_at > newest.recorded_at ? ping : newest,
    );

    await this.prisma.$executeRaw`
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

  async listTrail({
    businessId,
    driverId,
    from,
    to,
  }: {
    businessId: string;
    driverId: string;
    from: Date;
    to: Date;
  }): Promise<StoredPosition[]> {
    // `businessId` in the where even though `driverId` already implies it.
    // The use case checks the driver belongs to the company; this is the
    // second lock, and the one that holds when somebody adds a caller that
    // forgot the first.
    const rows = await this.prisma.driverPosition.findMany({
      where: {
        businessId,
        driverId,
        recorded_at: { gte: from, lte: to },
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
}

export { DriverPositionRepository };
