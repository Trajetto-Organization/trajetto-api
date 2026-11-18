import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * OBS-03: what the ops heartbeat reads from the database, against a real one.
 * The rules are unit-tested; this proves the SQL behind them runs, reads what
 * it claims, and that a stuck outbox event and an expired WhatsApp token
 * each turn into a reason the external check receives.
 */
const prisma = createPrismaClient();

const BUSINESS = "018fc000-0000-7000-8000-000000000fa1";
const USER = "018fc000-0000-7000-8000-000000000fa2";

let outboxEventId: string;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Alerta",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444000968",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `alerta-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa do Alerta",
      email: `alerta-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  // Due ten minutes ago and never taken: an expansion worker that stopped.
  const stuck = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `ops-heartbeat:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      payload: {},
      status: "PENDING",
      availableAt: new Date(Date.now() - 10 * 60 * 1000),
    },
  });

  outboxEventId = stuck.id;

  // A published event whose WhatsApp failed a minute ago on an expired token.
  const published = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `ops-heartbeat:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      payload: {},
      status: "PUBLISHED",
    },
  });

  await prisma.notificationDelivery.create({
    data: {
      outboxEventId: published.id,
      userId: USER,
      channel: "WHATSAPP",
      status: "FAILED",
      attempts: 1,
      lastError: "[whatsapp http=401 code=190] Session has expired",
    },
  });
}, 60_000);

afterAll(async () => {
  await prisma.domainOutboxEvent.deleteMany({
    where: { businessId: BUSINESS },
  });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });
  await prisma.$disconnect();
}, 60_000);

describe("the operational snapshot", () => {
  it("reads every part of the check without error", async () => {
    const { collectOperationalSnapshot } =
      await import("@/shared/health/operational-snapshot");

    const snapshot = await collectOperationalSnapshot();

    expect(snapshot.collectionErrors).toEqual([]);
    expect(snapshot.connectionUsagePercent).toBeGreaterThan(0);
    expect(snapshot.redisOk).toBe(true);
  });

  it("measures the stuck outbox event from when it became due", async () => {
    const { collectOperationalSnapshot } =
      await import("@/shared/health/operational-snapshot");

    const snapshot = await collectOperationalSnapshot();

    expect(snapshot.outboxEligibleLagSec).toBeGreaterThanOrEqual(590);
  });

  it("sees the recent credential failure and turns both into reasons", async () => {
    const { collectOperationalSnapshot } =
      await import("@/shared/health/operational-snapshot");
    const { evaluateAlerts } = await import("@/shared/health/alert-rules");

    const snapshot = await collectOperationalSnapshot();

    expect(snapshot.deliveryFailures).toContainEqual({
      channel: "WHATSAPP",
      lastError: "[whatsapp http=401 code=190] Session has expired",
    });

    const reasons = evaluateAlerts(snapshot);

    expect(reasons.some((reason) => /outbox/i.test(reason))).toBe(true);
    expect(reasons.some((reason) => reason.includes("code=190"))).toBe(true);
  });

  it("stops paging for the outbox once the event is taken", async () => {
    await prisma.domainOutboxEvent.update({
      where: { id: outboxEventId },
      data: { status: "PUBLISHED", processedAt: new Date() },
    });

    const { collectOperationalSnapshot } =
      await import("@/shared/health/operational-snapshot");

    const snapshot = await collectOperationalSnapshot();

    // Another file's event may be due at this instant; ours is not.
    expect(snapshot.outboxEligibleLagSec ?? 0).toBeLessThan(590);
  });
});

/**
 * Each replica's sockets against its ceiling (plano-escala F5-31), read from
 * its newest ops_sample row: only the process knows its count and its
 * descriptor limit, and the elected heartbeat judges them all.
 */
describe("the sockets of each replica", () => {
  const NEAR = `wfl-near-${randomUUID().slice(0, 8)}`;
  const CALM = `wfl-calm-${randomUUID().slice(0, 8)}`;
  const OLD_IMAGE = `wfl-old-${randomUUID().slice(0, 8)}`;

  const row = (
    replica: string,
    minutesAgo: number,
    realtime: Record<string, number>,
    role = "all",
  ) => ({
    ts: new Date(Date.now() - minutesAgo * 60_000),
    role,
    replica,
    metrics: { v: 1, realtime },
  });

  afterAll(async () => {
    await prisma.opsSample.deleteMany({
      where: { replica: { in: [NEAR, CALM, OLD_IMAGE] } },
    });
  });

  it("are read from the newest row of each replica, and page past 80%", async () => {
    await prisma.opsSample.createMany({
      data: [
        // An older, calm row of the same replica: the newest one counts.
        row(NEAR, 2, { local_connections: 100, socket_cap: 5_000 }),
        row(NEAR, 0.5, { local_connections: 4_200, socket_cap: 5_000 }),
        row(CALM, 0.5, { local_connections: 300, socket_cap: 3_072 }),
        // The previous image during a rolling deploy: no ceiling written.
        row(OLD_IMAGE, 0.5, { local_connections: 9_999 }),
        // Too old to be a live replica.
        row(OLD_IMAGE, 30, { local_connections: 9_999, socket_cap: 100 }),
      ],
    });

    const { collectOperationalSnapshot } =
      await import("@/shared/health/operational-snapshot");
    const { collectAlerts, DEFAULT_ALERT_THRESHOLDS } =
      await import("@/shared/health/alert-rules");

    const snapshot = await collectOperationalSnapshot();

    expect(snapshot.collectionErrors).toEqual([]);

    const ours = (snapshot.sockets ?? []).filter((replica) =>
      [NEAR, CALM, OLD_IMAGE].includes(replica.replica),
    );

    expect(ours).toEqual(
      expect.arrayContaining([
        { replica: NEAR, connections: 4_200, cap: 5_000 },
        { replica: CALM, connections: 300, cap: 3_072 },
      ]),
    );
    expect(ours).toHaveLength(2);

    const paged = collectAlerts(snapshot, DEFAULT_ALERT_THRESHOLDS, {
      pitrExpected: false,
    }).filter((alert) => alert.code === "socket-cap-high");

    expect(paged).toHaveLength(1);
    expect(paged[0].message).toContain(NEAR);
  });
});

describe("the memory budget of each replica", () => {
  /**
   * plano-escala U-15: each process writes in its ops_sample row whether
   * its heaps and native reserve fit its container's memory.max, and the
   * heartbeat pages for the newest row of any replica that does not.
   */
  const TIGHT = `wfl-tight-${randomUUID().slice(0, 8)}`;
  const FIXED = `wfl-fixed-${randomUUID().slice(0, 8)}`;
  const NO_CEILING = `wfl-noceil-${randomUUID().slice(0, 8)}`;
  const OLD_IMAGE = `wfl-oldmem-${randomUUID().slice(0, 8)}`;

  const row = (
    replica: string,
    minutesAgo: number,
    memoryBudget?: Record<string, string | number | boolean | null>,
  ) => ({
    ts: new Date(Date.now() - minutesAgo * 60_000),
    role: "all",
    replica,
    metrics: {
      v: 1,
      ...(memoryBudget && { memory_budget: memoryBudget }),
    },
  });

  afterAll(async () => {
    await prisma.opsSample.deleteMany({
      where: { replica: { in: [TIGHT, FIXED, NO_CEILING, OLD_IMAGE] } },
    });
  });

  it("pages for the newest row that does not fit, and for nothing else", async () => {
    const tight = { ok: false, total_mb: 1_174, limit_mb: 1_024, mode: "warn" };
    const fits = { ok: true, total_mb: 982, limit_mb: 1_024, mode: "warn" };

    await prisma.opsSample.createMany({
      data: [
        row(TIGHT, 0.5, tight),
        // Fixed by the last deploy: the newest row counts.
        row(FIXED, 2, tight),
        row(FIXED, 0.5, fits),
        // No ceiling to compare with: never judged.
        row(NO_CEILING, 0.5, {
          ok: null,
          total_mb: 918,
          limit_mb: null,
          mode: "warn",
        }),
        // The previous image during a rolling deploy writes none.
        row(OLD_IMAGE, 0.5),
      ],
    });

    const { collectOperationalSnapshot } =
      await import("@/shared/health/operational-snapshot");
    const { collectAlerts, DEFAULT_ALERT_THRESHOLDS } =
      await import("@/shared/health/alert-rules");

    const snapshot = await collectOperationalSnapshot();

    expect(snapshot.collectionErrors).toEqual([]);

    const ours = (snapshot.memoryBudgets ?? []).filter((replica) =>
      [TIGHT, FIXED, NO_CEILING, OLD_IMAGE].includes(replica.replica),
    );

    expect(ours).toEqual([{ replica: TIGHT, totalMb: 1_174, limitMb: 1_024 }]);

    const paged = collectAlerts(snapshot, DEFAULT_ALERT_THRESHOLDS, {
      pitrExpected: false,
    }).filter((alert) => alert.code === "memory-budget");

    expect(paged.map((alert) => alert.message).join(" ")).toContain(TIGHT);
    expect(paged.some((alert) => alert.message.includes(FIXED))).toBe(false);
  });
});

/**
 * plano-escala F3-34: the fleet of process_heartbeat, as the heartbeat
 * reads it. With the api in PROCESS_ROLE=api and no worker, a due outbox
 * event pages as a queue with no consumer; a row of another APP_ENV (a
 * process of the other environment pointed at this database) pages too;
 * a row out of the live window counts for nothing.
 */
describe("the processes of process_heartbeat", () => {
  const TAG = randomUUID().slice(0, 8);
  const API = `wfl-fleet-api-${TAG}`;
  const FOREIGN = `wfl-fleet-foreign-${TAG}`;
  const GONE = `wfl-fleet-gone-${TAG}`;

  afterAll(async () => {
    await prisma.processHeartbeat.deleteMany({
      where: { replica: { in: [API, FOREIGN, GONE] } },
    });
  });

  it("pages for the due outbox with no consumer, and for the other environment's process", async () => {
    const { env } = await import("@/env");
    const other = env.APP_ENV === "production" ? "staging" : "production";
    const row = (replica: string, extra: Record<string, unknown>) => ({
      replica,
      role: "api",
      app_env: env.APP_ENV,
      build_commit: "e2e-fleet",
      config_fingerprint: null,
      node_hostname: null,
      queues: [] as string[],
      cron: false,
      sockets: true,
      started_at: new Date(),
      ...extra,
    });

    await prisma.processHeartbeat.createMany({
      data: [
        row(API, {}),
        row(FOREIGN, {
          role: "worker",
          app_env: other,
          queues: ["outbox", "internal"],
        }),
        // A worker that stopped beating minutes ago: not a consumer.
        row(GONE, {
          role: "worker",
          queues: ["outbox", "internal", "external", "webhooks", "ai"],
          updated_at: new Date(Date.now() - 5 * 60_000),
        }),
      ],
    });

    // Due three minutes ago and never taken.
    await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `ops-heartbeat-fleet:${randomUUID()}`,
        topic: "account-payable.created",
        aggregateType: "account-payable",
        aggregateId: randomUUID(),
        businessId: BUSINESS,
        payload: {},
        status: "PENDING",
        availableAt: new Date(Date.now() - 3 * 60_000),
      },
    });

    const { collectOperationalSnapshot } =
      await import("@/shared/health/operational-snapshot");
    const { collectAlerts, DEFAULT_ALERT_THRESHOLDS } =
      await import("@/shared/health/alert-rules");

    const snapshot = await collectOperationalSnapshot();

    expect(snapshot.collectionErrors).toEqual([]);
    expect(snapshot.processes?.appEnv).toBe(env.APP_ENV);
    expect(
      snapshot.processes?.live.map((process) => process.replica).sort(),
    ).toEqual([API, FOREIGN].sort());

    const alerts = collectAlerts(snapshot, DEFAULT_ALERT_THRESHOLDS, {
      pitrExpected: false,
    });
    const messages = (code: string) =>
      alerts.filter((alert) => alert.code === code).map((a) => a.message);

    expect(messages("queue-no-consumer").join(" ")).toContain("fila outbox");
    expect(messages("foreign-environment")).toEqual([
      expect.stringContaining(`APP_ENV=${other}`),
    ]);
    expect(messages("foreign-environment")[0]).toContain(
      `worker em ${FOREIGN}`,
    );
  });
});

/**
 * The providers' refusals for rate (plano-escala F3-15c): each process
 * counts the 429s and the 130429s it heard in its ops_sample row, and the
 * elected heartbeat sums the last 24 h, the trigger to turn the provider's
 * rate bucket on. Measured as the difference our rows make: other files
 * may write rows of their own at the same time.
 */
describe("the providers' refusals for rate", () => {
  const LOUD = `wfl-throttled-${randomUUID().slice(0, 8)}`;
  const QUIET = `wfl-quiet-${randomUUID().slice(0, 8)}`;

  const row = (
    replica: string,
    minutesAgo: number,
    throttled?: Record<string, number>,
  ) => ({
    ts: new Date(Date.now() - minutesAgo * 60_000),
    role: "all",
    replica,
    metrics: {
      v: 1,
      ...(throttled && {
        provider_rate: {
          throttled: { whatsapp: 0, email: 0, push: 0, ...throttled },
          deferred: { whatsapp: 0, email: 0, push: 0 },
          local: { whatsapp: 0, email: 0, push: 0 },
        },
      }),
    },
  });

  afterAll(async () => {
    await prisma.opsSample.deleteMany({
      where: { replica: { in: [LOUD, QUIET] } },
    });
  });

  it("are summed over the last 24 h and page provider-throttled", async () => {
    const { collectOperationalSnapshot } =
      await import("@/shared/health/operational-snapshot");
    const { collectAlerts, DEFAULT_ALERT_THRESHOLDS } =
      await import("@/shared/health/alert-rules");

    const before = await collectOperationalSnapshot();

    expect(before.collectionErrors).toEqual([]);
    expect(before.providerThrottled).toBeDefined();

    await prisma.opsSample.createMany({
      data: [
        row(LOUD, 3, { whatsapp: 2 }),
        row(LOUD, 20 * 60, { email: 1, push: 4 }),
        // A day and an hour ago: out of the window.
        row(LOUD, 25 * 60, { whatsapp: 50 }),
        // A process that heard none writes no section.
        row(QUIET, 1),
      ],
    });

    const after = await collectOperationalSnapshot();

    expect(after.collectionErrors).toEqual([]);
    expect({
      whatsapp:
        after.providerThrottled!.whatsapp - before.providerThrottled!.whatsapp,
      email: after.providerThrottled!.email - before.providerThrottled!.email,
      push: after.providerThrottled!.push - before.providerThrottled!.push,
    }).toEqual({ whatsapp: 2, email: 1, push: 4 });

    const paged = collectAlerts(after, DEFAULT_ALERT_THRESHOLDS, {
      pitrExpected: false,
    }).filter((alert) => alert.code === "provider-throttled");

    expect(paged).toHaveLength(1);
    expect(paged[0].message).toContain("WHATSAPP_SENDS_PER_SECOND");
  });
});
