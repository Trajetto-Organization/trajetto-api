import { Prisma } from "@prisma/client";

/**
 * An instant as the value of a `timestamp(3)` column in raw SQL.
 *
 * The columns hold UTC wall time with no zone (Prisma's DateTime). Prisma 7
 * sends a raw parameter as text with no type (docs/adr/0011-orm-prisma-6-7-8.md),
 * so the ISO string is read as timestamptz and taken to UTC here, whatever
 * the session's TimeZone — the same as the local `utc()` helpers of the
 * repositories that already compare these columns by hand.
 */
function utcInstant(instant: Date): Prisma.Sql {
  return Prisma.sql`(${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

export { utcInstant };
