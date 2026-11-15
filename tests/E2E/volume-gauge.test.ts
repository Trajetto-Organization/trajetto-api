import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import type { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import type { OperationalSnapshot } from "@/shared/health/alert-rules";
import { generateApiKey } from "@/shared/integration/api-key-rules";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The ramp's gauge against Postgres (plano-escala U-12).
 *
 * Each process counts the deliveries it created, after the commit, on its
 * ops_sample row of the minute; the ops heartbeat's elected replica sums
 * those rows into the cluster row, and on the quarter-hours the 24 h and
 * 7 day sums the volume alert judges. What only the real series can prove:
 *
 *  - the cluster row sums the process rows since the previous cluster row,
 *    one minute behind them, never a row twice and never a cluster row;
 *  - missed heartbeat minutes are summed by the next one;
 *  - the quarter-hour sums cover 7 days and 24 h, this minute included, and
 *    the alert reads them on the quarter-hour and the minutes after it;
 *  - a delivery created through the API counts once; a replay and a
 *    refusal do not.
 *
 * The gate is 300 a month here, so the plan's "80% pages, 60% does not"
 * is 56 and 42 deliveries in the week (× 30/7 = 240 and 180).
 */
vi.hoisted(() => {
  process.env.APPROVED_GATE_MONTHLY_DELIVERIES = "300";
  process.env.OPS_SAMPLE_ENABLED = "true";
});

const prisma = createPrismaClient();

type Scheduler = {
  runExclusively(definition: CronJobDefinition, slot?: Date): Promise<void>;
};

let scheduler: Scheduler;
let heartbeat: CronJobDefinition;
let app: Awaited<typeof import("@/http")>["app"];
let gauge: typeof import("@/shared/health/volume-gauge");

const CARRIER = "018f6000-0000-7000-8000-0000000012a1";
const SHIPPER = "018f6000-0000-7000-8000-0000000012f1";
let writeKey: string;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora Régua",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "33444555000188",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `regua-${randomUUID()}@example.com`,
    },
  });
  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });
  await prisma.shipper.create({
    data: {
      id: SHIPPER,
      name: "Embarcador",
      cnpj: "12345678000195",
      businessId: CARRIER,
    },
  });

  const key = generateApiKey();

  await prisma.apiKey.create({
    data: {
      name: "ERP de teste",
      prefix: key.prefix,
      token_hash: key.tokenHash,
      scopes: ["deliveries:write"],
      businessId: CARRIER,
    },
  });
  writeKey = key.token;

  const { CronSchedulerService } =
    await import("@/shared/services/cron-scheduler-service");
  ({ opsHeartbeatJob: heartbeat } =
    await import("@/jobs/cron/ops-heartbeat-job"));
  gauge = await import("@/shared/health/volume-gauge");

  // The constructor is private (one per process in production).
  scheduler = new (CronSchedulerService as unknown as new () => Scheduler)();

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

/**
 * A range of its own per test, far from now and from each other: every
 * reading here looks back up to 7 days.
 */
let nextRange = 0;

function rangeAt(minute: number): Date {
  nextRange += 1;

  return new Date(
    Date.UTC(2031, 0, 1) + nextRange * 30 * 24 * 3_600_000 + minute * 60_000,
  );
}

const before = (slot: Date, seconds: number) =>
  new Date(slot.getTime() - seconds * 1_000);

/** A process row of the minute, with the section the sampler reads. */
async function processRow(ts: Date, created: number, replica = "api-1") {
  gauge.rotateDeliveriesCreated();
  gauge.countDeliveriesCreated(created);

  await prisma.opsSample.create({
    data: {
      ts,
      role: "all",
      replica,
      metrics: {
        v: 1,
        [gauge.VOLUME_SECTION]: gauge.rotateDeliveriesCreated(),
      },
    },
  });
}

async function clusterRow(ts: Date, deliveries: Record<string, number>) {
  await prisma.opsSample.create({
    data: {
      ts,
      role: "cluster",
      replica: "seed",
      metrics: { v: 1, deliveries },
    },
  });
}

async function deliveriesOf(ts: Date) {
  const rows = await prisma.$queryRaw<
    Array<{ deliveries: Record<string, unknown> | null }>
  >`
    SELECT metrics->'deliveries' AS deliveries
    FROM ops_sample WHERE role = 'cluster' AND ts = ${ts}
  `;

  expect(rows).toHaveLength(1);

  return rows[0].deliveries;
}

describe("the cluster row's count", () => {
  it("sums the process rows since the previous cluster row, a minute behind", async () => {
    const slot = rangeAt(7);

    // The previous cluster row, a minute ago: it summed up to T-120 s.
    await clusterRow(before(slot, 60), { created: 99 });

    await processRow(before(slot, 130), 50); // the previous row's already
    await processRow(before(slot, 90), 3, "api-1");
    await processRow(before(slot, 61), 2, "api-2");
    await processRow(before(slot, 30), 40); // the next row's: still landing

    await scheduler.runExclusively(heartbeat, slot);

    expect(await deliveriesOf(slot)).toEqual({ created: 5 });
  });

  it("sums the minutes a missed heartbeat left behind", async () => {
    const slot = rangeAt(9);

    // The last cluster row, five minutes ago: it summed up to T-6 min.
    await clusterRow(before(slot, 5 * 60), { created: 1 });

    for (const seconds of [400, 330, 300, 250, 190, 130, 70]) {
      await processRow(before(slot, seconds), 1);
    }

    await scheduler.runExclusively(heartbeat, slot);

    // (T-6 min, T-1 min]: every row after the old one's, none of its own.
    expect(await deliveriesOf(slot)).toEqual({ created: 6 });
  });

  it("starts from the minute before when there is no recent cluster row", async () => {
    const slot = rangeAt(11);

    await processRow(before(slot, 200), 7);
    await processRow(before(slot, 100), 4);

    await scheduler.runExclusively(heartbeat, slot);

    expect(await deliveriesOf(slot)).toEqual({ created: 4 });
  });
});

describe("the volume alert", () => {
  const SNAPSHOT: OperationalSnapshot = {
    now: new Date(),
    outboxEligibleLagSec: null,
    deliveryEligibleLagSec: { internal: null, external: null },
    webhookDueLagSec: null,
    aiEligibleLagSec: null,
    deliveryFailures: [],
    aiCredentialFailures: 0,
    cronJobs: [],
    partitionRunwayOk: true,
    partitionRunwayDays: 7,
    stuckWorkers: [],
    connectionUsagePercent: 10,
    redisOk: true,
    collectionErrors: [],
  };

  /** A week of cluster rows adding up to `week`, `day` of them in 24 h. */
  async function seedWeek(slot: Date, week: number, day: number) {
    const hour = 3_600;

    await clusterRow(before(slot, 8 * 24 * hour), { created: 1_000 }); // out
    await clusterRow(before(slot, 6 * 24 * hour), { created: week - day });
    await clusterRow(before(slot, 2 * hour), { created: day - 6 });
    await processRow(before(slot, 90), 6); // this minute's own
  }

  async function volumeReasons(slot: Date): Promise<string[]> {
    const { readClusterReadings } =
      await import("@/shared/health/cluster-sample");
    const { heartbeatReasons } = await import("@/jobs/cron/ops-heartbeat-job");

    const readings = await readClusterReadings(slot);

    return heartbeatReasons(SNAPSHOT, readings).filter((reason) =>
      reason.startsWith("Volume de entregas"),
    );
  }

  it("pages at 80% of the gate, on the quarter-hour and after it", async () => {
    const slot = rangeAt(45);

    await seedWeek(slot, 56, 16);
    await scheduler.runExclusively(heartbeat, slot);

    expect(await deliveriesOf(slot)).toEqual({
      created: 6,
      last_24h: 16,
      last_7d: 56,
      since: before(slot, 6 * 24 * 3_600).toISOString(),
    });

    const expected =
      /^Volume de entregas perto do portão aprovado: 56 nos últimos 7 dias, cerca de 240 por mês \(80% de 300, APPROVED_GATE_MONTHLY_DELIVERIES\).*\(runbook: docs\/runbooks\/volume-near-gate\.md\)$/;

    expect(await volumeReasons(slot)).toEqual([
      expect.stringMatching(expected),
    ]);

    // Off the quarter-hour, the newest quarter-hour's sums still judge.
    const minuteAfter = new Date(slot.getTime() + 60_000);

    expect(await volumeReasons(minuteAfter)).toEqual([
      expect.stringMatching(expected),
    ]);
  });

  it("stays quiet at 60% of the gate", async () => {
    const slot = rangeAt(30);

    await seedWeek(slot, 42, 12);
    await scheduler.runExclusively(heartbeat, slot);

    expect(await deliveriesOf(slot)).toMatchObject({ last_7d: 42 });
    expect(await volumeReasons(slot)).toEqual([]);
  });

  it("judges nothing once the newest sums are more than 20 minutes old", async () => {
    const slot = rangeAt(15);

    await seedWeek(slot, 56, 16);
    await scheduler.runExclusively(heartbeat, slot);

    const stale = new Date(slot.getTime() + 21 * 60_000);

    expect(await volumeReasons(stale)).toEqual([]);
  });
});

describe("a delivery created through the API", () => {
  function post(body: Record<string, unknown>, idempotencyKey: string) {
    return app.inject({
      method: "POST",
      url: "/integration/v1/deliveries",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${writeKey}`,
        "idempotency-key": idempotencyKey,
      },
      payload: JSON.stringify(body),
    });
  }

  const document = (overrides: Record<string, unknown> = {}) => ({
    shipper_id: SHIPPER,
    code: `PED-${randomUUID().slice(0, 8)}`,
    recipient_name: "Mercado Bom Preço Ltda",
    cep: "13010-000",
    street: "Rua das Flores",
    address_number: "120",
    neighborhood: "Centro",
    city: "Campinas",
    uf: "sp",
    scheduled_date: "2026-09-24",
    ...overrides,
  });

  it("counts once; a replay and a refusal count nothing", async () => {
    gauge.rotateDeliveriesCreated();

    const key = `pedido-${randomUUID()}`;
    const body = document();

    expect((await post(body, key)).statusCode).toBe(201);
    expect(gauge.rotateDeliveriesCreated()).toEqual({ created: 1 });

    // The same request again: the answer is the delivery it already made.
    expect((await post(body, key)).statusCode).toBe(200);
    expect(gauge.rotateDeliveriesCreated()).toEqual({ created: 0 });

    // A shipper that does not exist: refused before any row.
    const refused = await post(
      document({ shipper_id: "018f6000-0000-7000-8000-0000000012ff" }),
      `pedido-${randomUUID()}`,
    );

    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(gauge.rotateDeliveriesCreated()).toEqual({ created: 0 });
  });
});
