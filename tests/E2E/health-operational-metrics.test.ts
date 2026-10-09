import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * What the MASTER's "Sistema" tab needs to see during an incident, and did
 * not.
 *
 * The outbox turns an event PUBLISHED the moment it fans out into deliveries,
 * whatever happens to them next. So a provider outage — Meta down for 40
 * minutes, e-mail refused — never showed on the outbox: the screen read
 * "Sem fila" in green while WhatsApp deliveries piled up in backoff and
 * turned FAILED. The per-channel numbers were counts of rows CREATED in the
 * last 24 hours, so a delivery stuck for two days dropped out of them too.
 *
 * These seed that state and require the numbers that make it visible.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const MASTER = "018fda70-0000-7000-8000-0000000000m1";
const CARRIER = "018fda70-0000-7000-8000-00000000000a";
const STAFF = "018fda70-0000-7000-8000-0000000000s1";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

let masterToken = "";
let staffToken = "";

async function tokenFor(
  userId: string,
  role: string,
  businessId: string | null = null,
): Promise<string> {
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

  return sign(
    {
      tokenType: "access",
      role,
      businessId,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

/** An outbox event of this file, already fanned out (PUBLISHED). */
async function event(overrides: Record<string, unknown> = {}) {
  return prisma.domainOutboxEvent.create({
    data: {
      eventKey: `ops-metrics-${randomUUID()}`,
      topic: "metrics.operational",
      aggregateType: "metrics",
      aggregateId: randomUUID(),
      businessId: CARRIER,
      payload: {},
      status: "PUBLISHED",
      processedAt: new Date(),
      ...overrides,
    },
  });
}

/** A delivery to the MASTER user on `channel`, under a fresh event. */
async function delivery(
  channel: "IN_APP" | "EMAIL" | "WHATSAPP" | "PUSH" | "ACTIVITY",
  fields: Record<string, unknown>,
) {
  const { id: outboxEventId } = await event();

  return prisma.notificationDelivery.create({
    data: { outboxEventId, userId: MASTER, channel, ...fields },
  });
}

function metrics(token: string) {
  return app.inject({
    method: "GET",
    url: "/health/metrics",
    headers: { authorization: `Bearer ${token}` },
  });
}

type Channel = {
  channel: string;
  pending_total: number;
  processing_lease_expired: number;
  oldest_pending_seconds: number | null;
  oldest_eligible_seconds: number | null;
};

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Operação",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(56000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `ops-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.createMany({
    data: [
      {
        id: MASTER,
        name: "Master da Operação",
        email: `master-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "MASTER",
      },
      {
        id: STAFF,
        name: "Gestora da Operação",
        email: `staff-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
      },
    ],
  });

  masterToken = await tokenFor(MASTER, "MASTER");
  staffToken = await tokenFor(STAFF, "BUSINESS_ADMIN", CARRIER);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("a provider outage shows on the delivery lanes (OBS-04)", () => {
  it("reports how long the oldest WhatsApp delivery has been waiting", async () => {
    // Meta has been down for twenty minutes: the row is in backoff, its
    // availableAt in the future — invisible to an "eligible" lag.
    await delivery("WHATSAPP", {
      status: "PENDING",
      attempts: 2,
      created_at: new Date(Date.now() - 20 * MINUTE_MS),
      availableAt: new Date(Date.now() + 10 * MINUTE_MS),
    });

    const body = (await metrics(masterToken)).json();

    const whatsapp = body.notifications.channels.find(
      (entry: Channel) => entry.channel === "WHATSAPP",
    );

    expect(whatsapp.oldest_pending_seconds).toBeGreaterThanOrEqual(20 * 60 - 5);
    expect(whatsapp.pending_total).toBeGreaterThanOrEqual(1);

    // In backoff, so not "due": the eligible lag stays blind, on purpose.
    expect(whatsapp.oldest_eligible_seconds).toBeNull();
  });

  it("counts the webhooks that gave up today and watches their table", async () => {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        name: "Cliente fora do ar",
        url: "https://fora.exemplo.com.br/hook",
        secret: "whsec_teste",
        topics: ["delivery.*"],
        businessId: CARRIER,
      },
    });

    await prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        businessId: CARRIER,
        topic: "delivery.delivered",
        payload: {},
        signed_body: "{}",
        signature: "",
        status: "FAILED",
        attempts: 8,
      },
    });

    const body = (await metrics(masterToken)).json();

    expect(body.webhooks.failed_24h).toBe(1);

    const tables = body.queue_tables.map((entry: { table: string }) => entry.table);
    expect(tables).toContain("webhook_delivery");
  });

  it("counts the AI analyses that gave up today", async () => {
    const period = await prisma.aIUsagePeriod.create({
      data: { businessId: CARRIER, periodStart: new Date("2026-09-01") },
    });

    await prisma.aIAnalysisRequest.create({
      data: {
        idempotencyKey: randomUUID(),
        type: "CHECKLIST",
        recordId: randomUUID(),
        businessId: CARRIER,
        periodId: period.id,
        requestedById: MASTER,
        input: {},
        status: "FAILED",
      },
    });

    const body = (await metrics(masterToken)).json();

    expect(body.ai_pipeline.failed_24h).toBe(1);
  });
});

describe("what Meta said after it accepted a WhatsApp (OUTBOX-07)", () => {
  /**
   * The ledger knew and the screen did not: a message Meta accepted and then
   * failed keeps its delivery DELIVERED, and a delivery sent twice (the
   * duplicate at-least-once allows) is one DELIVERED row with two wamids.
   * Only a log line said either. These are the two numbers an alert needs.
   */
  async function receipt(fields: {
    deliveryId: string | null;
    providerMessageId: string;
    status: string;
    provider?: string;
    created_at?: Date;
  }) {
    await prisma.notificationProviderReceipt.create({
      data: {
        provider: "meta",
        occurredAt: fields.created_at ?? new Date(),
        ...fields,
      },
    });
  }

  it("counts the messages Meta failed and the deliveries it received twice, today only", async () => {
    const twice = await delivery("WHATSAPP", { status: "DELIVERED", attempts: 2 });
    const once = await delivery("WHATSAPP", { status: "DELIVERED", attempts: 1 });
    const lost = await delivery("WHATSAPP", { status: "DELIVERED", attempts: 1 });
    const lastWeek = await delivery("WHATSAPP", { status: "DELIVERED", attempts: 2 });

    const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);

    // Sent twice today: two wamids, each with its own callbacks.
    await receipt({ deliveryId: twice.id, providerMessageId: "wamid.twice-1", status: "sent" });
    await receipt({ deliveryId: twice.id, providerMessageId: "wamid.twice-1", status: "delivered" });
    await receipt({ deliveryId: twice.id, providerMessageId: "wamid.twice-2", status: "sent" });

    // Once, with every callback Meta sends: not a duplicate.
    await receipt({ deliveryId: once.id, providerMessageId: "wamid.once", status: "sent" });
    await receipt({ deliveryId: once.id, providerMessageId: "wamid.once", status: "delivered" });
    await receipt({ deliveryId: once.id, providerMessageId: "wamid.once", status: "read" });

    // Accepted, then failed by Meta.
    await receipt({ deliveryId: lost.id, providerMessageId: "wamid.lost", status: "sent" });
    await receipt({ deliveryId: lost.id, providerMessageId: "wamid.lost", status: "failed" });

    // Outside the window: a failure and a duplicate from two days ago.
    await receipt({ deliveryId: lastWeek.id, providerMessageId: "wamid.old-1", status: "sent", created_at: twoDaysAgo });
    await receipt({ deliveryId: lastWeek.id, providerMessageId: "wamid.old-2", status: "sent", created_at: twoDaysAgo });
    await receipt({ deliveryId: null, providerMessageId: "wamid.old-3", status: "failed", created_at: twoDaysAgo });

    // Another provider's error is not a WhatsApp failure.
    await receipt({ deliveryId: null, provider: "expo", providerMessageId: "ticket-1", status: "error" });

    const response = await metrics(masterToken);

    expect(response.statusCode).toBe(200);

    const { notifications } = response.json();

    expect(notifications.whatsapp_failed_24h).toBe(1);
    expect(notifications.whatsapp_multi_send_24h).toBe(1);
  });
});

describe("the delivery backlog is the current one, not a 24 h window (OUTBOX-15)", () => {
  it("measures the oldest pending e-mail from its creation", async () => {
    await delivery("EMAIL", {
      status: "PENDING",
      created_at: new Date(Date.now() - 60 * MINUTE_MS),
      availableAt: new Date(Date.now() - 60 * MINUTE_MS),
    });

    const email = (await metrics(masterToken))
      .json()
      .notifications.channels.find((entry: Channel) => entry.channel === "EMAIL");

    expect(email.oldest_pending_seconds).toBeGreaterThanOrEqual(3600 - 5);
    expect(email.pending_total).toBeGreaterThanOrEqual(1);

    // Due for an hour and not taken: the workers are not keeping up.
    expect(email.oldest_eligible_seconds).toBeGreaterThanOrEqual(3600 - 5);
  });

  it("counts a push whose worker died mid-send", async () => {
    await delivery("PUSH", {
      status: "PROCESSING",
      attempts: 1,
      leaseExpiresAt: new Date(Date.now() - 5 * MINUTE_MS),
      availableAt: new Date(Date.now() - 5 * MINUTE_MS),
    });

    const push = (await metrics(masterToken))
      .json()
      .notifications.channels.find((entry: Channel) => entry.channel === "PUSH");

    expect(push.processing_lease_expired).toBe(1);
  });

  it("keeps a delivery stuck for two days in the backlog", async () => {
    const before = (await metrics(masterToken))
      .json()
      .notifications.channels.find((entry: Channel) => entry.channel === "IN_APP");

    await delivery("IN_APP", {
      status: "PENDING",
      created_at: new Date(Date.now() - 2 * DAY_MS),
      availableAt: new Date(Date.now() - 2 * DAY_MS),
    });

    const after = (await metrics(masterToken))
      .json()
      .notifications.channels.find((entry: Channel) => entry.channel === "IN_APP");

    expect(after.pending_total).toBe((before?.pending_total ?? 0) + 1);
    expect(after.oldest_pending_seconds).toBeGreaterThanOrEqual(2 * 24 * 3600 - 5);
  });
});

describe("a stuck worker or cron job shows up (OBS-10)", () => {
  it("lists each replica's workers and flags the one that stopped beating", async () => {
    const { WorkerHeartbeatRegistry, flushHeartbeats } = await import(
      "@/shared/health/worker-heartbeat"
    );

    // Replica A, healthy: the outbox worker just finished a cycle.
    const healthy = new WorkerHeartbeatRegistry();
    healthy.beginCycle("notification-outbox");
    healthy.endCycle("notification-outbox");
    await flushHeartbeats(healthy, "replica-a");

    // Replica B: its e-mail lane started a cycle 16 minutes ago and has not
    // made progress for 15 — a claim hung on an await that never returns.
    const hung = new WorkerHeartbeatRegistry(
      () => new Date(Date.now() - 16 * MINUTE_MS),
    );
    hung.beginCycle("notification-delivery-external");
    await flushHeartbeats(hung, "replica-b");

    const workers = (await metrics(masterToken)).json().workers as Array<{
      replica: string;
      worker: string;
      stuck: boolean;
      running_since: string | null;
    }>;

    expect(
      workers.find((entry) => entry.replica === "replica-a"),
    ).toMatchObject({ worker: "notification-outbox", stuck: false, running_since: null });

    const stuck = workers.find((entry) => entry.replica === "replica-b");

    expect(stuck).toMatchObject({ worker: "notification-delivery-external", stuck: true });
    expect(stuck?.running_since).not.toBeNull();
  });

  it("forgets a replica that is gone, and the purge removes its rows", async () => {
    await prisma.workerHeartbeat.create({
      data: {
        replica: "replica-gone",
        worker: "ai-analysis",
        lastBeatAt: new Date(Date.now() - 2 * DAY_MS),
        updated_at: new Date(Date.now() - 2 * DAY_MS),
      },
    });

    const workers = (await metrics(masterToken)).json().workers as Array<{
      replica: string;
    }>;

    expect(workers.map((entry) => entry.replica)).not.toContain("replica-gone");

    const { cleanupNotificationPipelineJob } = await import(
      "@/jobs/cron/cleanup-notification-pipeline-job"
    );

    await cleanupNotificationPipelineJob.handler();

    expect(
      await prisma.workerHeartbeat.count({ where: { replica: "replica-gone" } }),
    ).toBe(0);
  });

  it("says when each cron job last succeeded, and which run was left behind", async () => {
    const minute = new Date();
    minute.setSeconds(0, 0);

    await prisma.scheduledJobExecution.create({
      data: {
        jobName: "driver-position-partitions",
        scheduledFor: new Date(minute.getTime() - 6 * 60 * MINUTE_MS),
        status: "SUCCEEDED",
        finishedAt: new Date(minute.getTime() - 6 * 60 * MINUTE_MS + 2_000),
        leaseExpiresAt: new Date(minute.getTime() - 5 * 60 * MINUTE_MS),
      },
    });

    // The replica running this purge died: the lease ran out, no finish.
    await prisma.scheduledJobExecution.create({
      data: {
        jobName: "cleanup-ai-pipeline",
        scheduledFor: new Date(minute.getTime() - 30 * MINUTE_MS),
        leaseExpiresAt: new Date(minute.getTime() - 20 * MINUTE_MS),
      },
    });

    const cron = (await metrics(masterToken)).json().cron_jobs as Array<{
      job: string;
      last_status: string | null;
      last_succeeded_at: string | null;
      stale_running: number;
    }>;

    const partitions = cron.find((entry) => entry.job === "driver-position-partitions");

    expect(partitions?.last_status).toBe("SUCCEEDED");
    expect(partitions?.last_succeeded_at).not.toBeNull();

    const purge = cron.find((entry) => entry.job === "cleanup-ai-pipeline");

    expect(purge).toMatchObject({ last_status: "RUNNING", stale_running: 1 });
    expect(purge?.last_succeeded_at).toBeNull();
  });
});

describe("the driver_position partition runway (INV-07)", () => {
  it("reports how many days of partitions are left", async () => {
    const { driverPositionPartitionsJob } = await import(
      "@/jobs/cron/driver-position-partitions-job"
    );

    await driverPositionPartitionsJob.handler();

    const body = (await metrics(masterToken)).json();

    // The job creates through today + 7; a week of runway, give or take the
    // hours already gone today.
    expect(body.driver_position.partition_runway_days).toBeGreaterThanOrEqual(6);
    expect(body.driver_position.runway_ok).toBe(true);
    expect(body.driver_position.last_partition_ends_at).not.toBeNull();
  });
});

describe("the replica's own saturation (GAP3-10, OBS-11)", () => {
  it("reports the Prisma pool and the runtime of the replica that answered", async () => {
    const runtime = (await metrics(masterToken)).json().runtime;

    expect(typeof runtime.replica).toBe("string");

    // The pool of THIS replica, from Prisma's own metrics: the pool is what
    // fills first, and pg_stat_activity against max_connections cannot see it.
    expect(typeof runtime.prisma_pool.busy).toBe("number");
    expect(typeof runtime.prisma_pool.idle).toBe("number");
    expect(typeof runtime.prisma_pool.waiting).toBe("number");
    expect(runtime.prisma_pool.open).toBeGreaterThanOrEqual(1);

    expect(typeof runtime.event_loop.utilization).toBe("number");
    expect(runtime.threadpool.size).toBeGreaterThan(0);
    expect(runtime.memory.rss_mb).toBeGreaterThan(0);

    expect(typeof runtime.bcrypt.active).toBe("number");
  });
});

describe("GET /health/dead-letter/events (OUTBOX-15)", () => {
  it("lists the outbox events that exhausted their retries, to the MASTER", async () => {
    const failed = await event({
      status: "FAILED",
      attempts: 10,
      processedAt: null,
      lastError: "Expansão falhou: destinatário inexistente",
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/dead-letter/events",
      headers: { authorization: `Bearer ${masterToken}` },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    const row = body.data.find((entry: { id: string }) => entry.id === failed.id);

    expect(row).toMatchObject({
      topic: "metrics.operational",
      businessId: CARRIER,
      attempts: 10,
      lastError: "Expansão falhou: destinatário inexistente",
    });
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it("and refuses anybody else", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/dead-letter/events",
      headers: { authorization: `Bearer ${staffToken}` },
    });

    expect(response.statusCode).toBe(403);
  });
});
