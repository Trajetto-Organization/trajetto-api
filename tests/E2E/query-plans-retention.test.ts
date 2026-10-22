import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * Retention of the API usage counts (db-perf 10/2026, docs/desempenho/banco-2026-10.md).
 *
 * api_key_usage_daily grew by a row per key, day, route, method and status
 * class with nothing ever removing one, while the screen reads 90 days at
 * most. The nightly cleanup-api-usage keeps 400 days, walking the oldest days
 * through api_key_usage_daily_day_idx.
 *
 * The job is imported lazily: before the fix the module did not exist, and a
 * static import would fail the whole file instead of each assertion.
 */
const prisma = new PrismaClient();

const CARRIER = randomUUID();
const KEY = randomUUID();

const DAY_MS = 24 * 60 * 60 * 1000;

/** The DATE of `daysAgo` days before today, as Prisma writes a @db.Date. */
function utcDay(daysAgo: number): Date {
  const today = new Date();
  return new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) -
      daysAgo * DAY_MS,
  );
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: `Retenção ${CARRIER.slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(56000000000000 + Math.floor(Math.random() * 9_000_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `retencao-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.apiKey.create({
    data: {
      id: KEY,
      businessId: CARRIER,
      name: "ERP",
      prefix: `trj_${randomUUID().slice(0, 8)}`,
      token_hash: randomUUID(),
      scopes: ["deliveries:read"],
    },
  });

  // Two years of daily buckets: the old ones go, the 400 most recent stay.
  await prisma.$executeRawUnsafe(
    `INSERT INTO api_key_usage_daily (id, "apiKeyId", "businessId", day, method, route, status_class, count, updated_at)
     SELECT gen_random_uuid()::text, $1, $2, (current_date AT TIME ZONE 'UTC')::date - g, 'GET', '/integration/v1/deliveries', 2, 10, now()
     FROM generate_series(0, 729) g`,
    KEY,
    CARRIER,
  );

  await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) "api_key_usage_daily"`);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the nightly API usage purge", () => {
  it("keeps 400 days and removes what is older", async () => {
    const { cleanupApiUsageJob, API_USAGE_RETENTION_DAYS } = await import(
      "@/jobs/cron/cleanup-api-usage-job"
    );

    expect(API_USAGE_RETENTION_DAYS).toBe(400);

    await cleanupApiUsageJob.handler();

    const kept = await prisma.apiKeyUsageDaily.findMany({
      where: { apiKeyId: KEY },
      select: { day: true },
      orderBy: { day: "asc" },
    });

    // The screen's longest window (90 days) is always whole.
    expect(kept.some((row) => row.day.getTime() === utcDay(89).getTime())).toBe(
      true,
    );
    expect(kept).toHaveLength(API_USAGE_RETENTION_DAYS);
    expect(kept[0].day.getTime()).toBe(
      utcDay(API_USAGE_RETENTION_DAYS - 1).getTime(),
    );
  });

  it("walks the oldest days through the day index, not the table", async () => {
    const { apiUsageRowsBefore } = await import(
      "@/jobs/cron/cleanup-api-usage-job"
    );

    const cutoff = new Date(Date.now() - 400 * DAY_MS);

    const rows = await prisma.$queryRaw<
      Array<{ "QUERY PLAN": unknown }>
    >(Prisma.sql`
      EXPLAIN (FORMAT JSON)
      SELECT "id" FROM "api_key_usage_daily" WHERE ${apiUsageRowsBefore(cutoff)} ORDER BY "day" LIMIT 5000
    `);

    const raw = rows[0]["QUERY PLAN"];
    const plan = JSON.stringify(
      typeof raw === "string" ? JSON.parse(raw) : raw,
    );

    expect(plan).toContain("api_key_usage_daily_day_idx");
    expect(plan).not.toContain('"Seq Scan"');
  });

  it("is scheduled", async () => {
    const { CronSchedulerService } = await import(
      "@/shared/services/cron-scheduler-service"
    );
    const { registerCronJobs } = await import("@/jobs/cron");

    const names: string[] = [];
    const scheduler = CronSchedulerService.getInstance();
    const original = scheduler.registerJob.bind(scheduler);

    scheduler.registerJob = ((definition: { name: string }) => {
      names.push(definition.name);
    }) as typeof scheduler.registerJob;

    try {
      registerCronJobs();
    } finally {
      scheduler.registerJob = original;
    }

    expect(names).toContain("cleanup-api-usage");
  });
});
