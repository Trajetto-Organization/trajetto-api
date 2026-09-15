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

    return count;
  }

  /**
   * The latest row per driver, in one query.
   *
   * `DISTINCT ON` rather than a window function or N queries: it is the one
   * construct Postgres has that reads the index for
   * `(driverId, recorded_at DESC)` and stops at the first row of each group.
   * With thirty drivers on the street a query per driver would be thirty round
   * trips on a screen that refreshes every few seconds.
   *
   * The driver's name and the truck's plate come from a join rather than from
   * a denormalised column on the position: a plate copied onto 864.000 rows a
   * day is a plate that is wrong on all of them the moment somebody fixes a
   * typo.
   */
  async listLatestByBusiness(
    businessId: string,
    since: Date,
  ): Promise<LivePosition[]> {
    return this.prisma.$queryRaw<LivePosition[]>(Prisma.sql`
      SELECT DISTINCT ON (p."driverId")
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
      FROM "driver_position" p
      LEFT JOIN "driver" d ON d."id" = p."driverId"
      LEFT JOIN "route" r ON r."id" = p."routeId"
      LEFT JOIN "vehicle" v ON v."id" = r."vehicleId"
      WHERE p."businessId" = ${businessId}
        AND p."recorded_at" >= ${since}
      ORDER BY p."driverId", p."recorded_at" DESC
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
