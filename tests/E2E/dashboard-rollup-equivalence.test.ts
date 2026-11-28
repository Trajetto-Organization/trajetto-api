import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { env } from "@/env";
import { runTenantDayRollup } from "@/jobs/cron/tenant-day-rollup-job";
import type {
  DeliveryWindow,
  PeriodCountBucket,
  PeriodGranularity,
} from "@/modules/dashboard/dtos/dashboard-dto";
import { DashboardRepository } from "@/modules/dashboard/repositories/dashboard-repository";
import { samePointLastMonth } from "@/modules/dashboard/usecases/shared/count-comparison";
import { dashboardRollupShadowIdle } from "@/modules/dashboard/usecases/shared/delivery-rollup";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  dashboardRollupMetrics,
  resetDashboardRollupMetrics,
} from "@/shared/rollup/dashboard-rollup-metrics";
import { TenantDayRollupRepository } from "@/shared/rollup/tenant-day-rollup-repository";
import {
  PENDING_DELIVERY_METRIC,
  dayBounds,
  deliveryMetric,
} from "@/shared/rollup/tenant-day-rules";
import {
  businessDateKey,
  businessDayStart,
  businessDayWindow,
  businessMonthWindow,
  shiftDateKey,
} from "@/shared/time/business-day";

import { seedBusiness, seedShipper, seedUser } from "../contract/seed";
import { seededDayWindow } from "./support/seeded-day";

/**
 * The dashboard's "Entregas" series read from the closed days (plano-escala
 * F4-22, decision D52) on a real Postgres. The acceptance: 300 windows
 * identical. Each window is counted the way the overview and the trends
 * count it today (DashboardRepository.countManyByPeriod, the live arm) and
 * the way DASHBOARD_ROLLUP_MODE=on counts it (the rollup's arm), for
 * companies in three zones, a company being purged, a company the job never
 * saw and the MASTER, over the screens' own windows, random ones aligned or
 * not to midnight, and clocks behind and ahead of the job's.
 *
 * The rows the rollup must NOT trust are there on purpose and the test
 * checks they are wrong: a day deleted after it was counted (its mark), a
 * day whose mark the job already took (its pending day), a day of a
 * company being purged (its marks dropped by the job). Read blindly, each
 * would give a number the live count never gives.
 *
 * Then the HTTP path: the overview and the trends answer the same in off,
 * shadow and on; the shadow compares on the side and agrees; a stored day
 * made wrong by hand is a divergence for the shadow, which still serves
 * the live count, and is served by on, which proves on reads the rows.
 */
const prisma = createPrismaClient();
const dashboard = new DashboardRepository(prisma);
const rollupRepo = new TenantDayRollupRepository(prisma);

let app: Awaited<typeof import("@/http")>["app"];

// The real clock, fixed for the file: the closed days are the ones before it.
const NOW = new Date();
const DAY_MS = 24 * 60 * 60 * 1000;

const SP = "America/Sao_Paulo";
const RIO_BRANCO = "America/Rio_Branco";
const NORONHA = "America/Noronha";
const MANAUS = "America/Manaus";

const PAULISTA = "018f6d00-0000-7000-8000-00000000000a";
const ACREANA = "018f6d00-0000-7000-8000-00000000000b";
const ILHEU = "018f6d00-0000-7000-8000-00000000000c";
const PURGADA = "018f6d00-0000-7000-8000-00000000000d";
const NOVA = "018f6d00-0000-7000-8000-00000000000e";

const ZONES: Record<string, string> = {
  [PAULISTA]: SP,
  [ACREANA]: RIO_BRANCO,
  [ILHEU]: NORONHA,
  [PURGADA]: SP,
  [NOVA]: MANAUS,
};

const ADMIN = "018f6d00-0000-7000-8000-0000000000a1";
const MASTER = "018f6d00-0000-7000-8000-0000000000f1";

const initialMode = env.DASHBOARD_ROLLUP_MODE;
const initialSnapshotTtl = env.DASHBOARD_SNAPSHOT_TTL_MS;

/** A small deterministic generator: the same 300 windows on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deliveries around midnights of several zones, and every ~37 h. */
function deliveriesOf(businessId: string, shipperId: string) {
  const midnights = [
    0, 1, 2, 5, 8, 9, 15, 31, 40, 62, 95, 200, 300, 380,
  ].flatMap((back) =>
    [SP, RIO_BRANCO, NORONHA, MANAUS, "UTC"].map(
      (zone) =>
        dayBounds(shiftDateKey(businessDateKey(NOW, zone), -back), zone).from,
    ),
  );

  const instants = [
    ...midnights.flatMap((midnight) =>
      [-60_000, 0, 60_000].map(
        (offset) => new Date(midnight.getTime() + offset),
      ),
    ),
    ...Array.from(
      { length: 272 },
      (_, index) => new Date(NOW.getTime() - (index + 1) * 37 * 3_600_000),
    ),
  ].filter((instant) => instant.getTime() < NOW.getTime() - 60_000);

  return instants.map((created_at) => ({
    recipient_name: "Cliente",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
    businessId,
    shipperId,
    created_at,
  }));
}

/** A delivery of the company seeded `days` days before NOW. */
async function deliveryAbout(
  businessId: string,
  days: number,
): Promise<{ id: string; created_at: Date }> {
  const found = await prisma.delivery.findFirst({
    where: {
      businessId,
      created_at: seededDayWindow(NOW, ZONES[businessId], days),
    },
    select: { id: true, created_at: true },
    orderBy: { created_at: "asc" },
  });

  expect(found, `a seeded delivery ${days} days back`).not.toBeNull();

  return found!;
}

/** The stored value and the live count of the civil day holding `instant`. */
async function storedAndLive(
  businessId: string,
  instant: Date,
): Promise<{ stored: number | undefined; live: number }> {
  const zone = ZONES[businessId];
  const day = businessDateKey(instant, zone);
  const row = await prisma.tenantDayCount.findUnique({
    where: {
      businessId_metric_day: {
        businessId,
        metric: deliveryMetric(zone),
        day: new Date(`${day}T00:00:00.000Z`),
      },
    },
  });
  const bounds = dayBounds(day, zone);
  const live = await prisma.delivery.count({
    where: {
      businessId,
      created_at: { gte: bounds.from, lt: bounds.to },
    },
  });

  return { stored: row ? Number(row.value) : undefined, live };
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

const sorted = (buckets: readonly PeriodCountBucket[]) =>
  [...buckets].sort((a, b) => a.period.localeCompare(b.period));

interface Case extends DeliveryWindow {
  businessId: string | undefined;
  timeZone: string;
  now: Date;
}

/** The 300 windows: the screens', random ones, and other clocks. */
function cases(): Case[] {
  const next = random(20261119);
  const subjects = [PAULISTA, ACREANA, ILHEU, PURGADA, NOVA, undefined];
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(next() * items.length)];
  const granularity = (): PeriodGranularity => pick(["day", "month"]);
  const all: Case[] = [];

  for (let index = 0; index < 300; index += 1) {
    const businessId = subjects[index % subjects.length];
    const timeZone = businessId ? ZONES[businessId] : SP;
    const today = businessDateKey(NOW, timeZone);
    const kind = Math.floor(index / subjects.length) % 5;
    let now = NOW;
    let window: DeliveryWindow;

    if (kind === 0) {
      // What the screens ask for.
      const screens: Array<() => DeliveryWindow> = [
        () => ({
          ...span(businessDayWindow(NOW, timeZone, 7)),
          granularity: "day",
        }),
        () => ({
          ...span(businessDayWindow(NOW, timeZone, 30)),
          granularity: "day",
        }),
        () => ({
          ...span(businessMonthWindow(NOW, timeZone, 4)),
          granularity: "month",
        }),
        () => ({
          ...span(businessMonthWindow(NOW, timeZone, 6)),
          granularity: "month",
        }),
        () => ({
          ...span(businessMonthWindow(NOW, timeZone, 7)),
          granularity: "month",
        }),
        () => ({
          ...span(businessMonthWindow(NOW, timeZone, 13)),
          granularity: "month",
        }),
        () => ({ ...samePointLastMonth(NOW, timeZone), granularity: "month" }),
      ];

      window = pick(screens)();
    } else if (kind === 1) {
      // Whole days, anywhere in the history.
      const first = shiftDateKey(today, -Math.floor(next() * 420));
      const length = 1 + Math.floor(next() * 120);

      window = {
        from: businessDayStart(first, timeZone),
        to: businessDayStart(shiftDateKey(first, length), timeZone),
        granularity: granularity(),
      };
    } else if (kind === 2) {
      // Any instant to any instant: clipped days at both ends.
      const from = new Date(NOW.getTime() - Math.floor(next() * 420 * DAY_MS));

      window = {
        from,
        to: new Date(
          from.getTime() + 60_000 + Math.floor(next() * 100 * DAY_MS),
        ),
        granularity: granularity(),
      };
    } else if (kind === 3) {
      // A clock behind the job's: its "today" and later have rows.
      now = new Date(NOW.getTime() - Math.floor(next() * 60 * DAY_MS));
      window =
        next() < 0.5
          ? {
              ...span(businessDayWindow(now, timeZone, 30)),
              granularity: "day",
            }
          : {
              ...span(businessMonthWindow(now, timeZone, 7)),
              granularity: "month",
            };
    } else {
      // A clock ahead of the job's: the days after its last row are live.
      now = new Date(NOW.getTime() + (1 + Math.floor(next() * 3)) * DAY_MS);
      window = {
        ...span(businessDayWindow(now, timeZone, 30)),
        granularity: "day",
      };
    }

    all.push({ ...window, businessId, timeZone, now });
  }

  return all;
}

function span(window: { start: Date; end: Date }) {
  return { from: window.start, to: window.end };
}

const tokens = new Map<string, string>();

async function tokenFor(userId: string): Promise<string> {
  const cached = tokens.get(userId);

  if (cached) return cached;

  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const token = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );

  tokens.set(userId, token);

  return token;
}

async function get(userId: string, url: string) {
  const response = await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${await tokenFor(userId)}` },
  });

  expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

  return response.body;
}

beforeAll(async () => {
  for (const [index, businessId] of [
    PAULISTA,
    ACREANA,
    ILHEU,
    PURGADA,
  ].entries()) {
    await seedBusiness(prisma, businessId, 660 + index, {
      timezone: ZONES[businessId],
    });

    const shipper = await seedShipper(
      prisma,
      businessId,
      `Embarcador ${index}`,
    );

    await prisma.delivery.createMany({
      data: deliveriesOf(businessId, shipper.id),
    });
  }

  const report = await runTenantDayRollup({ now: NOW });

  expect(report?.left).toEqual([]);

  // A company the job never saw: no row at all.
  await seedBusiness(prisma, NOVA, 670, { timezone: MANAUS });
  await prisma.delivery.createMany({
    data: deliveriesOf(
      NOVA,
      (await seedShipper(prisma, NOVA, "Embarcador novo")).id,
    ),
  });

  // A day whose mark the job already took: pending, not counted yet.
  const pendingGone = await deliveryAbout(PAULISTA, 95);

  await prisma.delivery.delete({ where: { id: pendingGone.id } });

  // A company being purged: its deletions leave marks the job only drops.
  await prisma.business.update({
    where: { id: PURGADA },
    data: { purge_state: "PURGING" },
  });

  const purged = await deliveryAbout(PURGADA, 40);

  await prisma.delivery.delete({ where: { id: purged.id } });
  await rollupRepo.takeDirtyMarks(100);

  // Marks still there: a deletion and a status change.
  const markedGone = await deliveryAbout(ACREANA, 200);

  await prisma.delivery.delete({ where: { id: markedGone.id } });

  const changed = await deliveryAbout(ILHEU, 62);

  await prisma.delivery.update({
    where: { id: changed.id },
    data: { status: "CANCELLED" },
  });

  // Today, created after the job ran.
  await prisma.delivery.create({
    data: {
      ...deliveriesOf(
        PAULISTA,
        (
          await prisma.shipper.findFirstOrThrow({
            where: { businessId: PAULISTA },
          })
        ).id,
      )[0],
      created_at: new Date(NOW.getTime() - 30_000),
    },
  });

  // Each row the rollup must not trust is wrong, or the test proves nothing.
  expect(await prisma.tenantDayDirty.count()).toBe(2);
  expect(
    await prisma.tenantDayCount.count({
      where: { metric: PENDING_DELIVERY_METRIC },
    }),
  ).toBe(1);

  for (const [businessId, gone] of [
    [PAULISTA, pendingGone],
    [PURGADA, purged],
    [ACREANA, markedGone],
  ] as const) {
    const { stored, live } = await storedAndLive(businessId, gone.created_at);

    expect(stored, businessId).toBe(live + 1);
  }

  await seedUser(prisma, PAULISTA, 671, { id: ADMIN, role: "BUSINESS_ADMIN" });
  await seedUser(prisma, null, 672, { id: MASTER, role: "MASTER" });
  await prisma.businessEntitlement.create({
    data: { businessId: PAULISTA, module: "DELIVERIES", enabled: true },
  });

  ({ app } = await import("@/http"));
  await app.ready();

  // Each mode is compared on the read itself: the 60 s snapshot of the
  // dashboard (F4-23) would hand a later mode the numbers an earlier one
  // computed. Its own proof is tests/E2E/dashboard-snapshot-http.test.ts.
  env.DASHBOARD_SNAPSHOT_TTL_MS = 0;
}, 120_000);

afterAll(async () => {
  env.DASHBOARD_ROLLUP_MODE = initialMode;
  env.DASHBOARD_SNAPSHOT_TTL_MS = initialSnapshotTtl;
  await dashboardRollupShadowIdle();
  await app?.close();
  await prisma.$disconnect();
});

describe("the rollup's arm against the live count", () => {
  it("answers 300 windows exactly as the live count does", async () => {
    let compared = 0;

    for (const window of cases()) {
      const params = {
        entities: ["delivery" as const],
        from: window.from,
        to: window.to,
        granularity: window.granularity,
        timeZone: window.timeZone,
      };
      const label = `${window.businessId ?? "MASTER"} ${window.timeZone} ${window.granularity} ${window.from.toISOString()}..${window.to.toISOString()} now=${window.now.toISOString()}`;

      const live = await dashboard.countManyByPeriod(params, window.businessId);
      const rollup = await dashboard.countManyByPeriod(
        { ...params, deliveriesFromRollup: { now: window.now } },
        window.businessId,
      );

      expect(sorted(rollup.delivery), label).toEqual(sorted(live.delivery));

      const [both] = await dashboard.countDeliveryWindows(
        {
          windows: [window],
          timeZone: window.timeZone,
          now: window.now,
          sources: ["live", "rollup"],
        },
        window.businessId,
      );

      expect(sorted(both.live ?? []), label).toEqual(sorted(live.delivery));
      expect(sorted(both.rollup ?? []), label).toEqual(sorted(live.delivery));

      compared += 1;
    }

    expect(compared).toBe(300);
  }, 240_000);

  it("reads both sources of several windows in ONE statement", async () => {
    let statements = 0;
    const counting = new DashboardRepository({
      $queryRaw: (...args: Parameters<typeof prisma.$queryRaw>) => {
        statements += 1;

        return prisma.$queryRaw(...args);
      },
    } as unknown as typeof prisma);
    const windows = [
      {
        ...span(businessMonthWindow(NOW, SP, 6)),
        granularity: "month" as const,
      },
      { ...samePointLastMonth(NOW, SP), granularity: "month" as const },
    ];

    const answer = await counting.countDeliveryWindows(
      { windows, timeZone: SP, now: NOW, sources: ["live", "rollup"] },
      PAULISTA,
    );

    expect(statements).toBe(1);

    expect(answer).toHaveLength(2);
    expect(answer[0].live?.length).toBeGreaterThan(0);

    for (const entry of answer) {
      expect(sorted(entry.rollup ?? [])).toEqual(sorted(entry.live ?? []));
    }
  });

  it("reads a company's stored days by their key and its live days by the delivery index", async () => {
    // The point of the rollup is not to read months of deliveries: no
    // table of the arm may need a sequential scan for one company.
    const statements: Array<{ query: string; params: string }> = [];
    const counted = createPrismaClient({
      log: [{ level: "query", emit: "event" }],
    });

    counted.$on(
      "query" as never,
      (event: { query: string; params: string }) => {
        statements.push(event);
      },
    );

    try {
      await new DashboardRepository(counted as never).countManyByPeriod(
        {
          entities: ["delivery"],
          ...span(businessMonthWindow(NOW, SP, 13)),
          granularity: "month",
          timeZone: SP,
          deliveriesFromRollup: { now: NOW },
        },
        PAULISTA,
      );
    } finally {
      await counted.$disconnect();
    }

    const [statement] = statements.filter((sent) =>
      sent.query.includes('"tenant_day_count"'),
    );
    const scans = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");

      const rows = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
        `EXPLAIN (FORMAT JSON) ${statement.query}`,
        ...(JSON.parse(statement.params) as unknown[]),
      );
      const raw = rows[0]["QUERY PLAN"];
      const plan = (
        (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{
          Plan: PlanNode;
        }>
      )[0].Plan;

      return flatten(plan).filter((node) => node["Relation Name"]);
    });

    expect(
      scans
        .filter((node) => node["Node Type"] === "Seq Scan")
        .map((node) => node["Relation Name"]),
    ).toEqual([]);

    for (const table of ["delivery", "tenant_day_count", "tenant_day_dirty"]) {
      expect(
        scans.some(
          (node) =>
            node["Relation Name"] === table && /Index/.test(node["Node Type"]),
        ),
        table,
      ).toBe(true);
    }
  });

  it("reads the stored rows: a row made wrong by hand moves the rollup, not the live count", async () => {
    const day = shiftDateKey(businessDateKey(NOW, SP), -3);
    const key = {
      businessId: PAULISTA,
      metric: deliveryMetric(SP),
      day: new Date(`${day}T00:00:00.000Z`),
    };
    const row = await prisma.tenantDayCount.findUniqueOrThrow({
      where: { businessId_metric_day: key },
    });
    const window = {
      from: businessDayStart(day, SP),
      to: businessDayStart(shiftDateKey(day, 1), SP),
      granularity: "day" as const,
      timeZone: SP,
    };

    await prisma.tenantDayCount.update({
      where: { businessId_metric_day: key },
      data: { value: row.value + 1000n },
    });

    try {
      const [answer] = await dashboard.countDeliveryWindows(
        {
          windows: [window],
          timeZone: SP,
          now: NOW,
          sources: ["live", "rollup"],
        },
        PAULISTA,
      );

      expect(answer.rollup).toEqual([
        { period: day, count: Number(row.value) + 1000 },
      ]);
      expect(answer.live).toEqual(
        Number(row.value) > 0
          ? [{ period: day, count: Number(row.value) }]
          : [],
      );
    } finally {
      await prisma.tenantDayCount.update({
        where: { businessId_metric_day: key },
        data: { value: row.value },
      });
    }
  });
});

describe("the overview and the trends over HTTP", () => {
  const URLS = [
    "/dashboard/overview",
    "/dashboard/trends?period=7d",
    "/dashboard/trends?period=30d",
    "/dashboard/trends?period=12m",
  ];

  it("answer the same with off, shadow and on, and the shadow agrees", async () => {
    resetDashboardRollupMetrics();

    for (const url of URLS) {
      env.DASHBOARD_ROLLUP_MODE = "off";
      const off = await get(ADMIN, url);

      env.DASHBOARD_ROLLUP_MODE = "shadow";
      const shadow = await get(ADMIN, url);

      await dashboardRollupShadowIdle();

      env.DASHBOARD_ROLLUP_MODE = "on";
      const on = await get(ADMIN, url);

      expect(shadow, url).toBe(off);
      expect(on, url).toBe(off);
    }

    // The MASTER's trends add every company up (its overview is the
    // platform snapshot of a minute, the same in every mode).
    env.DASHBOARD_ROLLUP_MODE = "off";
    const off = await get(MASTER, "/dashboard/trends?period=12m");

    env.DASHBOARD_ROLLUP_MODE = "shadow";
    const shadow = await get(MASTER, "/dashboard/trends?period=12m");

    await dashboardRollupShadowIdle();

    env.DASHBOARD_ROLLUP_MODE = "on";
    expect(await get(MASTER, "/dashboard/trends?period=12m")).toBe(off);
    expect(shadow).toBe(off);

    // Two windows for the overview, one per trend.
    expect(dashboardRollupMetrics()).toMatchObject({
      windows_compared: 6,
      windows_agreed: 6,
      windows_diverged: 0,
      failures: 0,
      on_fallbacks: 0,
    });
  });

  it("a wrong stored day is a divergence for the shadow, which serves live; on serves it", async () => {
    resetDashboardRollupMetrics();

    const day = shiftDateKey(businessDateKey(NOW, SP), -2);
    const key = {
      businessId: PAULISTA,
      metric: deliveryMetric(SP),
      day: new Date(`${day}T00:00:00.000Z`),
    };
    const row = await prisma.tenantDayCount.findUniqueOrThrow({
      where: { businessId_metric_day: key },
    });

    env.DASHBOARD_ROLLUP_MODE = "off";
    const live = JSON.parse(await get(ADMIN, "/dashboard/trends?period=30d"));

    await prisma.tenantDayCount.update({
      where: { businessId_metric_day: key },
      data: { value: row.value + 1000n },
    });

    try {
      env.DASHBOARD_ROLLUP_MODE = "shadow";
      const shadow = JSON.parse(
        await get(ADMIN, "/dashboard/trends?period=30d"),
      );

      await dashboardRollupShadowIdle();

      expect(shadow).toEqual(live);
      expect(dashboardRollupMetrics()).toMatchObject({
        windows_compared: 1,
        windows_diverged: 1,
        windows_raced: 0,
      });

      env.DASHBOARD_ROLLUP_MODE = "on";
      const on = JSON.parse(await get(ADMIN, "/dashboard/trends?period=30d"));

      // The 28th of 30 points is D−2.
      expect(on.activityTrends[27].deliveries).toBe(
        live.activityTrends[27].deliveries + 1000,
      );
    } finally {
      await prisma.tenantDayCount.update({
        where: { businessId_metric_day: key },
        data: { value: row.value },
      });
    }
  });
});
