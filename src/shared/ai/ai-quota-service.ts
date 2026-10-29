import database from "@/../infra/database";
import { AIUsagePeriod, Prisma } from "@prisma/client";

import { quotaPeriodFor } from "./ai-period";

/**
 * The quota ledger over AIUsagePeriod. The limit stays on Business — raising
 * it mid-month applies immediately — while reservation/consumption happens
 * here with row-level locking, so concurrent requests can never spend past
 * the limit the way the legacy check-then-increment counter could.
 *
 * The month is the company's civil month (Business.timezone, AI-15).
 */

/** Photos analysed in the period, by what they were (AI-10). */
interface QuotaUsageByType {
  fuel: number;
  checklist: number;
  proof: number;
}

interface QuotaUsage {
  /** Provider calls that actually happened — photos analysed. */
  consumed: number;

  /** Reserved for analyses still running; returned to the pool if they fail. */
  inProgress: number;

  limit: number;

  /** What a reservation would grant right now: limit − consumed − inProgress. */
  remaining: number;

  /** The date-only key of the period (day 1 of the company's month). */
  periodStart: Date;

  /** The ledger row of the period; null until its first analysis. */
  periodId: string | null;

  /** When the period began and when the next begins, as instants. */
  startsAt: Date;
  resetAt: Date;

  timeZone: string;
}

type DatabaseClient = Prisma.TransactionClient | typeof database;

async function businessTimeZone(
  db: DatabaseClient,
  businessId: string,
): Promise<string | null> {
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });

  return business?.timezone ?? null;
}

async function getOrCreateCurrentPeriod(
  db: DatabaseClient,
  businessId: string,
): Promise<AIUsagePeriod> {
  const { periodStart } = quotaPeriodFor(
    new Date(),
    await businessTimeZone(db, businessId),
  );
  const where = { businessId_periodStart: { businessId, periodStart } };

  const existing = await db.aIUsagePeriod.findUnique({ where });
  if (existing) return existing;

  // The month's first analyses of a company race to create this row, inside
  // requestAnalysis's transaction. `upsert({ update: {} })` ran a SELECT and
  // an INSERT there, and the loser's P2002 aborted its whole transaction —
  // which requestAnalysis reads as "already running", so that record was
  // never analysed (tests/E2E/get-or-create-races.test.ts). ON CONFLICT DO
  // NOTHING waits for the winner instead, and the read after it sees its row
  // (READ COMMITTED: each statement takes a fresh snapshot).
  await db.aIUsagePeriod.createMany({
    data: [{ businessId, periodStart }],
    skipDuplicates: true,
  });

  return db.aIUsagePeriod.findUniqueOrThrow({ where });
}

/**
 * Atomically reserves up to `requested` units against the business limit and
 * returns how many were granted (possibly zero). The period row is locked
 * for the computation, so two replicas reserving at once serialize instead
 * of both reading the same remainder. Mirrors the pure `grantedUnits` rule.
 */
async function reserveUnits(
  db: DatabaseClient,
  periodId: string,
  businessId: string,
  requested: number,
): Promise<number> {
  if (requested <= 0) return 0;

  const rows = await db.$queryRaw<{ granted: number }[]>`
    WITH quota AS (
      SELECT p."id",
             GREATEST(
               0,
               LEAST(
                 ${requested},
                 b."ai_analysis_limit" - p."reservedUnits" - p."consumedUnits"
               )
             )::int AS granted
      FROM "ai_usage_period" p
      JOIN "business" b ON b."id" = ${businessId}
      WHERE p."id" = ${periodId}
      FOR UPDATE OF p
    )
    UPDATE "ai_usage_period" SET
      "reservedUnits" = "reservedUnits" + quota.granted,
      "updated_at" = now()
    FROM quota
    WHERE "ai_usage_period"."id" = quota."id"
    RETURNING quota.granted
  `;

  return rows[0]?.granted ?? 0;
}

/** Moves one unit from reserved to consumed (a provider call succeeded). */
async function consumeReservedUnit(
  db: DatabaseClient,
  periodId: string,
): Promise<void> {
  await db.aIUsagePeriod.update({
    where: { id: periodId },
    data: {
      reservedUnits: { decrement: 1 },
      consumedUnits: { increment: 1 },
    },
  });
}

/** Gives units back (retries exhausted without a successful provider call). */
async function releaseReservedUnits(
  db: DatabaseClient,
  periodId: string,
  count: number,
): Promise<void> {
  if (count <= 0) return;

  await db.aIUsagePeriod.update({
    where: { id: periodId },
    data: { reservedUnits: { decrement: count } },
  });
}

/**
 * Current-month usage for a business. In-flight reservations are committed
 * spend for the "remaining" math (so nothing can over-grant), but they are
 * reported separately — an analysis that is still running is not a photo
 * analysed.
 */
async function getQuotaUsage(businessId: string): Promise<QuotaUsage | null> {
  const business = await database.business.findUnique({
    where: { id: businessId },
    select: { ai_analysis_limit: true, timezone: true },
  });

  if (!business) return null;

  const period = quotaPeriodFor(new Date(), business.timezone);

  const row = await database.aIUsagePeriod.findUnique({
    where: {
      businessId_periodStart: { businessId, periodStart: period.periodStart },
    },
  });

  const consumed = row?.consumedUnits ?? 0;
  const inProgress = row?.reservedUnits ?? 0;

  return {
    consumed,
    inProgress,
    limit: business.ai_analysis_limit,
    remaining: Math.max(0, business.ai_analysis_limit - consumed - inProgress),
    periodStart: period.periodStart,
    periodId: row?.id ?? null,
    startsAt: period.startsAt,
    resetAt: period.resetAt,
    timeZone: period.timeZone,
  };
}

/**
 * Photos analysed this period, per kind of record (AI-10): the card said
 * "abastecimentos e checklists" while the receipts spent the same quota.
 *
 * Exactly what the ledger charged to this period: units consumed by the
 * period's requests (ai_analysis_request_periodId_idx) since the period began.
 * A request revived into this month keeps the units it consumed before, and
 * those were charged to their own month — the consumedAt bound leaves them
 * out, as the ledger did.
 */
async function getQuotaUsageByType(
  periodId: string | null,
  startsAt: Date,
): Promise<QuotaUsageByType> {
  if (!periodId) return { fuel: 0, checklist: 0, proof: 0 };

  // consumedAt is a naive UTC timestamp; the bound is compared as UTC wall
  // time so the session's zone cannot move the month (an ISO string: Prisma
  // 7's pg driver sends a Date without its offset).
  const rows = await database.$queryRaw<Array<{ type: string; n: number }>>`
    SELECT r."type"::text AS "type", count(*)::int AS n
    FROM "ai_analysis_request" r
    JOIN "ai_analysis_unit" u ON u."requestId" = r."id"
    WHERE r."periodId" = ${periodId}
      AND u."status" = 'CONSUMED'
      AND u."consumedAt" >= (${startsAt.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY r."type"
  `;

  const count = (type: string) => rows.find((row) => row.type === type)?.n ?? 0;

  return {
    fuel: count("FUEL_ODOMETER"),
    checklist: count("CHECKLIST"),
    proof: count("DELIVERY_PROOF"),
  };
}

export {
  consumeReservedUnit,
  getOrCreateCurrentPeriod,
  getQuotaUsage,
  getQuotaUsageByType,
  releaseReservedUnits,
  reserveUnits,
};

export type { QuotaUsage, QuotaUsageByType };
