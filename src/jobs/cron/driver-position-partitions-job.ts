import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";

/**
 * How far ahead partitions are created.
 *
 * Seven days rather than one. A job that only ever creates tomorrow's has no
 * slack: one missed night — a deploy, a replica that was down, a schedule that
 * did not fire — and the first ping of the day is not a warning, it is an
 * error, because a range-partitioned table with no partition for a row REFUSES
 * the insert. A week of runway means six consecutive failures before anybody
 * loses a position.
 */
const PARTITION_LOOKAHEAD_DAYS = 7;

/**
 * How long a trail is kept.
 *
 * Ninety days: long enough to answer "onde o caminhão estava no dia 12" when a
 * customer disputes a delivery, short enough that the table has a ceiling. The
 * legal record of a delivery is the proof document and its events, not this —
 * this is the map.
 */
const PARTITION_RETENTION_DAYS = 90;

function partitionName(day: Date): string {
  return `driver_position_${day.toISOString().slice(0, 10).replace(/-/g, "")}`;
}

function utcMidnight(offsetDays: number): Date {
  const day = new Date();

  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() + offsetDays);

  return day;
}

/**
 * Creates the days ahead and drops the days behind.
 *
 * Both halves in one job, deliberately. They are the same invariant seen from
 * two ends — "there is exactly one partition for every day we care about" —
 * and splitting them into two schedules is how one of them ends up disabled
 * and nobody notices until the disk fills or the inserts start failing.
 *
 * Cron: "10 4 * * *" → daily at 04:10, after the purges.
 */
const driverPositionPartitionsJob: CronJobDefinition = {
  name: "driver-position-partitions",
  schedule: "10 4 * * *",

  async handler() {
    let created = 0;

    // From yesterday, not from today: a replica whose clock is behind, or a
    // ping recorded on the device just before midnight and flushed after,
    // both land on yesterday.
    for (let offset = -1; offset <= PARTITION_LOOKAHEAD_DAYS; offset += 1) {
      const from = utcMidnight(offset);
      const to = utcMidnight(offset + 1);

      const name = partitionName(from);

      // IF NOT EXISTS rather than a check first: two replicas run this at the
      // same second, and the race between "does it exist" and "create it" is
      // exactly the kind that only shows up in production.
      //
      // Unsafe-by-name because DDL cannot take bind parameters — a table name
      // is not a value. Nothing here comes from a request: `name` and both
      // bounds are built from a Date this function computed.
      await database.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "driver_position"
           FOR VALUES FROM ('${from.toISOString()}') TO ('${to.toISOString()}')`,
      );

      created += 1;
    }

    // What is actually attached, asked of the catalogue rather than computed
    // from a name pattern: a partition created by hand during an incident is
    // still a partition, and a job that only knows its own naming would leave
    // it to grow forever.
    const attached = await database.$queryRaw<Array<{ relname: string }>>(
      Prisma.sql`
        SELECT child.relname::text AS relname
        FROM pg_inherits
        JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
        JOIN pg_class child ON child.oid = pg_inherits.inhrelid
        WHERE parent.relname = 'driver_position'
      `,
    );

    const cutoff = utcMidnight(-PARTITION_RETENTION_DAYS);
    const cutoffName = partitionName(cutoff);

    let dropped = 0;

    for (const { relname } of attached) {
      // Compared as strings because the name IS the date, zero-padded: a
      // lexicographic comparison of `driver_position_YYYYMMDD` is a
      // chronological one, and parsing it back into a Date to compare would
      // be a parser to get wrong.
      if (!/^driver_position_\d{8}$/.test(relname)) continue;

      if (relname >= cutoffName) continue;

      // DROP and not DELETE. This is the entire reason the table is
      // partitioned: a day is removed in milliseconds, with no dead tuples for
      // autovacuum to chase and no long transaction pinning the xmin horizon.
      await database.$executeRawUnsafe(`DROP TABLE IF EXISTS "${relname}"`);

      dropped += 1;
    }

    console.log(
      `[DriverPositionPartitions] ${created} partição(ões) garantida(s), ` +
        `${dropped} removida(s) por retenção`,
    );
  },
};

export {
  PARTITION_LOOKAHEAD_DAYS,
  PARTITION_RETENTION_DAYS,
  driverPositionPartitionsJob,
  partitionName,
};
