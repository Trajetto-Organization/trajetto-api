import database from "@/../infra/database";
import { AIUsagePeriod, Prisma } from "@prisma/client";

import { nextPeriodStartFor, periodStartFor } from "./ai-rules";

/**
 * The quota ledger over AIUsagePeriod. The limit stays on Business — raising
 * it mid-month applies immediately — while reservation/consumption happens
 * here with row-level locking, so concurrent requests can never spend past
 * the limit the way the legacy check-then-increment counter could.
 */

interface QuotaUsage {
  /** Provider calls that actually happened — what "verificações realizadas" means. */
  consumed: number;

  /** Reserved for analyses still running; returned to the pool if they fail. */
  inProgress: number;

  limit: number;

  /** What a reservation would grant right now: limit − consumed − inProgress. */
  remaining: number;

  periodStart: Date;
  resetAt: Date;
}

type DatabaseClient = Prisma.TransactionClient | typeof database;

async function getOrCreateCurrentPeriod(
  db: DatabaseClient,
  businessId: string,
): Promise<AIUsagePeriod> {
  const periodStart = periodStartFor(new Date());

  return db.aIUsagePeriod.upsert({
    where: { businessId_periodStart: { businessId, periodStart } },
    create: { businessId, periodStart },
    update: {},
  });
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
 * reported separately — an analysis that is still running is not a
 * "verificação realizada".
 */
async function getQuotaUsage(businessId: string): Promise<QuotaUsage | null> {
  const business = await database.business.findUnique({
    where: { id: businessId },
    select: { ai_analysis_limit: true },
  });

  if (!business) return null;

  const now = new Date();
  const periodStart = periodStartFor(now);

  const period = await database.aIUsagePeriod.findUnique({
    where: { businessId_periodStart: { businessId, periodStart } },
  });

  const consumed = period?.consumedUnits ?? 0;
  const inProgress = period?.reservedUnits ?? 0;

  return {
    consumed,
    inProgress,
    limit: business.ai_analysis_limit,
    remaining: Math.max(0, business.ai_analysis_limit - consumed - inProgress),
    periodStart,
    resetAt: nextPeriodStartFor(now),
  };
}

export {
  consumeReservedUnit,
  getOrCreateCurrentPeriod,
  getQuotaUsage,
  releaseReservedUnits,
  reserveUnits,
};

export type { QuotaUsage };
