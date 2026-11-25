import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { runTenantDayRollup } from "@/jobs/cron/tenant-day-rollup-job";
import { DashboardRepository } from "@/modules/dashboard/repositories/dashboard-repository";
import { createPrismaClient } from "@/shared/database/database-client";
import { rollUpTenantDays } from "@/shared/rollup/tenant-day-rollup";
import { TenantDayRollupRepository } from "@/shared/rollup/tenant-day-rollup-repository";
import {
  PENDING_DELIVERY_METRIC,
  dayBounds,
  daysBetween,
  deliveryMetric,
  rollupZones,
  zoneCalendar,
} from "@/shared/rollup/tenant-day-rules";
import { businessDateKey, shiftDateKey } from "@/shared/time/business-day";

import { seedBusiness, seedShipper } from "../contract/seed";
import { seededDayWindow } from "./support/seeded-day";

/**
 * The dashboard's closed days on a real Postgres (plano-escala F4-21,
 * decision D52). The acceptance: the count is exact in three zones. Each
 * stored day equals the dashboard's own live count of that day
 * (DashboardRepository.countManyByPeriod, the query the overview and the
 * trends run today), in each company's zone and in the platform's, where
 * the days of every company add up to the MASTER's count.
 *
 * And what only the database can show: a delivery deleted long after its
 * day was counted is counted again from its mark; a writer that changed a
 * day while the old mark was there (so the trigger left no mark of its own)
 * is waited for before the day is counted, and a run that cannot wait, or
 * dies after taking the marks, leaves their days for the next run.
 *
 * Runs in the one-file-at-a-time phase (SERIAL_E2E_FILES): that wait reads
 * the snapshot's xmin, which belongs to the whole cluster, so a writer
 * another file keeps open in its own database would hold it past the test's
 * timeout, and this file's open writers would hold the other files back.
 */
const prisma = createPrismaClient();
const repo = new TenantDayRollupRepository(prisma);
const dashboard = new DashboardRepository(prisma);

// The real clock, fixed for the file: the days are the ones before it.
const NOW = new Date();

const COMPANIES = [
  { id: "018f6c00-0000-7000-8000-00000000000a", zone: "America/Sao_Paulo" },
  { id: "018f6c00-0000-7000-8000-00000000000b", zone: "America/Rio_Branco" },
  { id: "018f6c00-0000-7000-8000-00000000000c", zone: "America/Noronha" },
];
const [PAULISTA, ACREANA, ILHEU] = COMPANIES.map((company) => company.id);

const shippers = new Map<string, string>();
const sessions: pg.Client[] = [];

async function session(): Promise<pg.Client> {
  const url = new URL(process.env.DATABASE_URL as string);

  url.searchParams.delete("schema");

  const client = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 10_000,
    application_name: "tenant-day-rollup-e2e",
  });

  await client.connect();
  sessions.push(client);

  return client;
}

/** The ids of a company's deliveries seeded `days` days before NOW. */
async function deliveriesAbout(
  businessId: string,
  days: number,
): Promise<Array<{ id: string; created_at: Date }>> {
  const zone = COMPANIES.find((company) => company.id === businessId)!.zone;
  const found = await prisma.delivery.findMany({
    where: { businessId, created_at: seededDayWindow(NOW, zone, days) },
    select: { id: true, created_at: true },
    orderBy: { created_at: "asc" },
  });

  expect(found.length, `seeded deliveries ${days} days back`).toBeGreaterThan(
    0,
  );

  return found;
}

/** Two deliveries of the same UTC day: the second one's mark is the first's. */
async function twoOfOneUtcDay(
  businessId: string,
  days: number,
): Promise<[{ id: string }, { id: string }]> {
  const found = await deliveriesAbout(businessId, days);
  const utcDay = (instant: Date) => instant.toISOString().slice(0, 10);
  const index = found.findIndex(
    (delivery, at) =>
      at > 0 &&
      utcDay(delivery.created_at) === utcDay(found[at - 1].created_at),
  );

  return [found[index - 1], found[index]];
}

async function storedDays(
  businessId: string,
  metric: string,
): Promise<Map<string, number>> {
  const rows = await prisma.tenantDayCount.findMany({
    where: { businessId, metric },
  });

  return new Map(
    rows.map((row) => [row.day.toISOString().slice(0, 10), Number(row.value)]),
  );
}

/** The dashboard's live count of each day of the history, in a zone. */
async function liveDays(
  businessId: string | undefined,
  zone: string,
): Promise<Map<string, number>> {
  const calendar = zoneCalendar(NOW, zone);
  const counts = await dashboard.countManyByPeriod(
    {
      entities: ["delivery"],
      from: dayBounds(calendar.historyStart, zone).from,
      to: dayBounds(calendar.today, zone).from,
      granularity: "day",
      timeZone: zone,
    },
    businessId,
  );

  return new Map(
    (counts.delivery ?? []).map((bucket) => [bucket.period, bucket.count]),
  );
}

/** Every closed day of the history is stored, and equal to the live count. */
async function expectExact(): Promise<void> {
  for (const company of COMPANIES) {
    for (const zone of rollupZones(company.zone)) {
      const calendar = zoneCalendar(NOW, zone);
      const stored = await storedDays(company.id, deliveryMetric(zone));
      const live = await liveDays(company.id, zone);

      expect([...stored.keys()].sort(), `${company.zone} in ${zone}`).toEqual(
        daysBetween(calendar.historyStart, calendar.yesterday),
      );

      for (const [day, value] of stored) {
        expect(value, `${company.zone} in ${zone}, ${day}`).toBe(
          live.get(day) ?? 0,
        );
      }
    }
  }
}

async function marksAndPending(): Promise<{ marks: number; pending: number }> {
  return {
    marks: await prisma.tenantDayDirty.count(),
    pending: await prisma.tenantDayCount.count({
      where: { metric: PENDING_DELIVERY_METRIC },
    }),
  };
}

beforeAll(async () => {
  for (const [index, company] of COMPANIES.entries()) {
    await seedBusiness(prisma, company.id, 640 + index, {
      timezone: company.zone,
    });
    shippers.set(
      company.id,
      (await seedShipper(prisma, company.id, `Embarcador ${index}`)).id,
    );

    // A minute either side of each zone's midnight and of UTC's, on days
    // inside the recounted window, just out of it, and deep in the history.
    const data = [0, 1, 2, 8, 9, 40, 200, 380].flatMap((back) =>
      ["America/Sao_Paulo", "America/Rio_Branco", "America/Noronha", "UTC"]
        .map(
          (zone) =>
            dayBounds(shiftDateKey(businessDateKey(NOW, zone), -back), zone)
              .from,
        )
        .flatMap((midnight) =>
          [-60_000, 0, 60_000].map((offset) => ({
            recipient_name: "Cliente",
            city: "São Paulo",
            uf: "SP",
            street: "Rua das Entregas",
            businessId: company.id,
            shipperId: shippers.get(company.id) as string,
            created_at: new Date(midnight.getTime() + offset),
          })),
        ),
    );

    await prisma.delivery.createMany({ data });
  }
});

afterAll(async () => {
  await Promise.all(sessions.map((client) => client.end()));
  await prisma.$disconnect();
});

describe("the cron's run", () => {
  it("stores every closed day exactly in three zones, as the dashboard counts them live", async () => {
    const report = await runTenantDayRollup({ now: NOW });

    expect(report?.left).toEqual([]);
    await expectExact();

    // The platform's calendar adds every company up: the MASTER's count.
    const platform = "America/Sao_Paulo";
    const master = await liveDays(undefined, platform);
    const sums = new Map<string, number>();

    for (const company of COMPANIES) {
      for (const [day, value] of await storedDays(
        company.id,
        deliveryMetric(platform),
      )) {
        sums.set(day, (sums.get(day) ?? 0) + value);
      }
    }

    for (const [day, value] of sums) {
      expect(value, day).toBe(master.get(day) ?? 0);
    }
  });
});

describe("a day changed after it was counted", () => {
  it("is counted again from its mark, however old", async () => {
    await rollUpTenantDays({ repo, now: NOW });

    const [gone] = await deliveriesAbout(ACREANA, 200);

    await prisma.delivery.delete({ where: { id: gone.id } });
    expect((await marksAndPending()).marks).toBe(1);

    const report = await rollUpTenantDays({ repo, now: NOW });

    expect(report.left).toEqual([]);
    expect(report.pendingSettled).toBe(1);
    expect(await marksAndPending()).toEqual({ marks: 0, pending: 0 });
    await expectExact();
  });

  it("waits for a writer that changed it under the old mark before counting it", async () => {
    await rollUpTenantDays({ repo, now: NOW });

    const [first, second] = await twoOfOneUtcDay(PAULISTA, 40);

    // The first delete marks the UTC day; the writer's delete of the same
    // day, in a transaction still open, sees that mark and adds none.
    await prisma.delivery.delete({ where: { id: first.id } });

    const writer = await session();

    await writer.query("BEGIN");
    await writer.query(`DELETE FROM "delivery" WHERE "id" = $1`, [second.id]);

    expect((await marksAndPending()).marks).toBe(1);

    const run = rollUpTenantDays({
      repo,
      now: NOW,
      settleWaitMs: 120_000,
      pollMs: 50,
    });

    // The run took the mark and is waiting for the writer.
    await vi.waitFor(
      async () =>
        expect(await marksAndPending()).toEqual({ marks: 0, pending: 1 }),
      { timeout: 30_000, interval: 50 },
    );

    await writer.query("COMMIT");

    const report = await run;

    expect(report.left).toEqual([]);
    expect(await marksAndPending()).toEqual({ marks: 0, pending: 0 });
    await expectExact();
  });

  it("stays pending while a writer outlives the wait, and is counted by the next run", async () => {
    await rollUpTenantDays({ repo, now: NOW });

    const [first, second] = await twoOfOneUtcDay(ILHEU, 380);

    await prisma.delivery.delete({ where: { id: first.id } });

    const writer = await session();

    await writer.query("BEGIN");
    await writer.query(`DELETE FROM "delivery" WHERE "id" = $1`, [second.id]);

    const stopped = await rollUpTenantDays({
      repo,
      now: NOW,
      settleWaitMs: 200,
      pollMs: 50,
    });

    expect(stopped.left).toContain("settle");
    expect(await marksAndPending()).toEqual({ marks: 0, pending: 1 });

    await writer.query("COMMIT");

    const next = await rollUpTenantDays({ repo, now: NOW });

    expect(next.left).toEqual([]);
    expect(await marksAndPending()).toEqual({ marks: 0, pending: 0 });
    await expectExact();
  });

  it("is still counted when the run that took its mark died before counting", async () => {
    await rollUpTenantDays({ repo, now: NOW });

    const [gone] = await deliveriesAbout(PAULISTA, 200);

    await prisma.delivery.delete({ where: { id: gone.id } });

    // A run that took the marks and stopped there (a crash, a deploy).
    expect(await repo.takeDirtyMarks(100)).toEqual({ taken: 1, added: 1 });

    const report = await rollUpTenantDays({ repo, now: NOW });

    expect(report.pendingSettled).toBe(1);
    expect(await marksAndPending()).toEqual({ marks: 0, pending: 0 });
    await expectExact();
  });
});

describe("a company being purged", () => {
  it("is left alone, and its marks are dropped", async () => {
    await rollUpTenantDays({ repo, now: NOW });

    const before = await storedDays(ILHEU, deliveryMetric("America/Noronha"));
    const [gone] = await deliveriesAbout(ILHEU, 2);

    await prisma.business.update({
      where: { id: ILHEU },
      data: { purge_state: "PURGING" },
    });

    try {
      await prisma.delivery.delete({ where: { id: gone.id } });

      const report = await rollUpTenantDays({ repo, now: NOW });

      expect(report.businesses).toBe(2);
      expect(await marksAndPending()).toEqual({ marks: 0, pending: 0 });
      expect(
        await storedDays(ILHEU, deliveryMetric("America/Noronha")),
      ).toEqual(before);
    } finally {
      await prisma.business.update({
        where: { id: ILHEU },
        data: { purge_state: null },
      });
    }

    await rollUpTenantDays({ repo, now: NOW });
    await expectExact();
  });
});
