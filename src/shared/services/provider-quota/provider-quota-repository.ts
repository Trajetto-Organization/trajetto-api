import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

/**
 * A provider's day, counted per scope in Postgres (plano-escala F2-32;
 * decision D23): what is money or a contract — the geocoder's quota today,
 * WhatsApp's per company in wave 13 — must not vanish with a Redis
 * eviction, nor come back for free after one.
 *
 * One row per provider, scope and UTC day (provider_quota_day). A take of
 * one scope is one INSERT ... ON CONFLICT DO UPDATE that counts only below
 * the limit: the row's lock serializes concurrent takers, and each one
 * re-checks the limit on the row as the one before it left it, so 50
 * parallel takes with a limit of 10 grant exactly 10, across replicas and
 * processes alike.
 *
 * A take of several scopes (the search's platform day and the company's)
 * counts all of them or none, in one statement after the rows exist: it
 * locks them in one order — by name, so two takers queue instead of waiting
 * on each other crosswise — reads them as the last taker left them, and
 * counts them only when none is at its limit. No interactive transaction:
 * nothing holds a pooled connection between two round trips.
 *
 * A scope with a colon is a part of the scope before it — the company's
 * share of "address-search" is "address-search:<businessId>" — so the
 * account's day is the sum of the scopes without one (the quota alert).
 *
 * Fails like the database: a caller that cannot read or take must not ask
 * the provider (fail closed).
 */
interface QuotaUnit {
  scope: string;
  /** Takes nothing at this count or above; 0 or less takes nothing. */
  limit: number;
  /**
   * What the day already reached somewhere else — the previous image's
   * Redis key, during a rolling deploy: the row counts on from the greater
   * of the two, so the old replicas' calls are not spent twice.
   */
  floor?: number;
}

type QuotaTake =
  /** Each unit's count after the take, in the order asked. */
  | { granted: true; used: number[] }
  /**
   * The first scope at its limit in the lock order (lockOrder: by name, so
   * a scope before its parts — the platform's day before a company's).
   */
  | { granted: false; refused: string };

interface IProviderQuotaRepository {
  /** The day's counts of these scopes; 0 for a scope with no row. */
  used(
    provider: string,
    day: string,
    scopes: readonly string[],
  ): Promise<Record<string, number>>;

  /** One unit of every scope, or none. */
  take(
    provider: string,
    day: string,
    units: readonly QuotaUnit[],
  ): Promise<QuotaTake>;

  /**
   * One unit of a scope's day back, never below 0 (plano-escala F3-15b):
   * a call the provider refused without counting it (Meta's 130429) must
   * not spend the day. Nothing for a row that does not exist.
   */
  giveBack(provider: string, day: string, scope: string): Promise<void>;
}

/** The UTC day a quota counts in, as the row's `day` (YYYY-MM-DD). */
function quotaDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** A whole number at least 0: a floor that is not one counts as 0. */
function floorOf(unit: QuotaUnit): number {
  const floor = Math.floor(unit.floor ?? 0);

  return Number.isFinite(floor) && floor > 0 ? floor : 0;
}

/**
 * The units in the order their rows are locked: by the scope's code units,
 * the order Postgres gives under COLLATE "C", the same for every taker.
 */
function lockOrder(units: readonly QuotaUnit[]): number[] {
  return units
    .map((_, index) => index)
    .sort((a, b) =>
      units[a].scope < units[b].scope
        ? -1
        : units[a].scope > units[b].scope
          ? 1
          : 0,
    );
}

class ProviderQuotaRepository implements IProviderQuotaRepository {
  constructor(private readonly prisma = database) {}

  async used(
    provider: string,
    day: string,
    scopes: readonly string[],
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = Object.fromEntries(
      scopes.map((scope) => [scope, 0]),
    );

    if (scopes.length === 0) return counts;

    // The primary key: one probe per scope.
    const rows = await this.prisma.$queryRaw<
      Array<{ scope: string; used: number }>
    >`
      SELECT "scope", "used"
      FROM "provider_quota_day"
      WHERE "provider" = ${provider}
        AND "day" = ${day}::date
        AND "scope" = ANY(${[...scopes]}::text[])
    `;

    for (const row of rows) counts[row.scope] = Number(row.used);

    return counts;
  }

  async take(
    provider: string,
    day: string,
    units: readonly QuotaUnit[],
  ): Promise<QuotaTake> {
    if (units.length === 0) return { granted: true, used: [] };

    const off = lockOrder(units).find((index) => units[index].limit <= 0);

    if (off !== undefined) return { granted: false, refused: units[off].scope };

    if (units.length === 1) {
      const used = await this.takeOne(provider, day, units[0]);

      return used === null
        ? { granted: false, refused: units[0].scope }
        : { granted: true, used: [used] };
    }

    return this.takeAll(provider, day, units);
  }

  async giveBack(provider: string, day: string, scope: string): Promise<void> {
    // The primary key, and the row's lock: a concurrent take re-checks the
    // limit on the count this leaves.
    await this.prisma.$executeRaw`
      UPDATE "provider_quota_day"
      SET "used" = GREATEST("used" - 1, 0),
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "provider" = ${provider}
        AND "scope" = ${scope}
        AND "day" = ${day}::date
        AND "used" > 0
    `;
  }

  /**
   * One unit of one scope: the row's count after it, or null at the limit.
   * The INSERT proposes a row only below the limit (counting from the
   * floor); on the existing row, the UPDATE counts only while the greater
   * of the row and the floor is below it, re-checked on the row as the
   * last taker left it.
   */
  private async takeOne(
    provider: string,
    day: string,
    unit: QuotaUnit,
  ): Promise<number | null> {
    const floor = floorOf(unit);
    const rows = await this.prisma.$queryRaw<Array<{ used: number }>>`
      INSERT INTO "provider_quota_day"
        ("provider", "scope", "day", "used", "updated_at")
      SELECT ${provider}, ${unit.scope}, ${day}::date, ${floor}::int + 1,
        CURRENT_TIMESTAMP
      WHERE ${floor}::int < ${unit.limit}::int
      ON CONFLICT ("provider", "scope", "day") DO UPDATE
        SET "used" = GREATEST("provider_quota_day"."used", ${floor}::int) + 1,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE GREATEST("provider_quota_day"."used", ${floor}::int)
          < ${unit.limit}::int
      RETURNING "used"
    `;

    return rows.length > 0 ? Number(rows[0].used) : null;
  }

  /**
   * One unit of every scope, or none, in two statements: the rows made to
   * exist (at 0, untouched when they do), then one statement that locks
   * them in name order, decides on the versions it locked — the newest, as
   * FOR UPDATE reads them after waiting — and counts them all only when
   * none is at its limit. The UPDATE meets the rows it locked itself and
   * counts on from their newest version, so a concurrent taker's unit is
   * never lost.
   */
  private async takeAll(
    provider: string,
    day: string,
    units: readonly QuotaUnit[],
  ): Promise<QuotaTake> {
    const values = Prisma.join(
      units.map(
        (unit) =>
          Prisma.sql`(${unit.scope}::text, ${unit.limit}::int, ${floorOf(unit)}::int)`,
      ),
    );

    await this.prisma.$executeRaw`
      INSERT INTO "provider_quota_day"
        ("provider", "scope", "day", "used", "updated_at")
      SELECT ${provider}, w."scope", ${day}::date, 0, CURRENT_TIMESTAMP
      FROM (VALUES ${values}) AS w("scope", "lim", "floor")
      ON CONFLICT ("provider", "scope", "day") DO NOTHING
    `;

    const rows = await this.prisma.$queryRaw<
      Array<{ refused: string | null; scope: string | null; used: number }>
    >`
      WITH w("scope", "lim", "floor") AS (VALUES ${values}),
      locked AS MATERIALIZED (
        SELECT q."scope", q."used"
        FROM "provider_quota_day" AS q
        WHERE q."provider" = ${provider}
          AND q."day" = ${day}::date
          AND q."scope" IN (SELECT w."scope" FROM w)
        ORDER BY q."scope" COLLATE "C"
        FOR UPDATE
      ),
      verdict AS MATERIALIZED (
        SELECT min(w."scope" COLLATE "C") FILTER (
          WHERE l."scope" IS NULL OR GREATEST(l."used", w."floor") >= w."lim"
        ) AS "refused"
        FROM w
        LEFT JOIN locked AS l ON l."scope" = w."scope"
      ),
      taken AS (
        UPDATE "provider_quota_day" AS q
        SET "used" = GREATEST(q."used", w."floor") + 1,
            "updated_at" = CURRENT_TIMESTAMP
        FROM w, verdict
        WHERE verdict."refused" IS NULL
          AND q."provider" = ${provider}
          AND q."day" = ${day}::date
          AND q."scope" = w."scope"
        RETURNING q."scope", q."used"
      )
      SELECT NULL::text AS "refused", "scope", "used" FROM taken
      UNION ALL
      SELECT "refused", NULL::text, 0 FROM verdict WHERE "refused" IS NOT NULL
    `;

    const refused = rows.find((row) => row.refused !== null)?.refused;

    if (refused) return { granted: false, refused };

    const after = new Map(rows.map((row) => [row.scope, Number(row.used)]));

    return {
      granted: true,
      used: units.map((unit) => after.get(unit.scope) ?? 0),
    };
  }
}

export { ProviderQuotaRepository, floorOf, lockOrder, quotaDay };
export type { IProviderQuotaRepository, QuotaTake, QuotaUnit };
