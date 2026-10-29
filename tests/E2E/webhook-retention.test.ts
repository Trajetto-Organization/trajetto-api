import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WebhookDeliveryStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * How long the webhook ledger keeps a row, and what the monitor reads.
 *
 * The replay window was only ever a refusal: a resend older than thirty days
 * was turned down, and the row itself stayed forever — the payload twice
 * (JSONB and the signed bytes) plus a kilobyte of the receiver's answer, for
 * every event of every subscribed endpoint. The monitor then grouped the
 * tenant's entire history by status on each refresh, and pulled every latency
 * of the day into Node to sort it for one percentile.
 *
 * The job is imported lazily: before the fix the module did not exist, and a
 * static import would fail the whole file instead of the one assertion.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const PURGED = "018fdc20-0000-7000-8000-00000000000a";
const MONITORED = "018fdc20-0000-7000-8000-00000000000b";
const ADMIN = "018fdc20-0000-7000-8000-0000000000a1";

const DAY_MS = 24 * 60 * 60 * 1000;

let token = "";

async function tokenFor(userId: string, businessId: string): Promise<string> {
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
      role: "BUSINESS_ADMIN",
      businessId,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

async function company(id: string, name: string): Promise<string> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: name,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(55000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `retencao-${randomUUID()}@exemplo.com.br`,
    },
  });

  // Integrations belong to Entregas (decision 4.3).
  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: "ERP",
      url: "https://erp.exemplo.com.br/webhooks",
      secret: "whsec_teste",
      topics: ["delivery.created"],
      businessId: id,
    },
  });

  return endpoint.id;
}

function row(
  businessId: string,
  endpointId: string,
  status: WebhookDeliveryStatus,
  createdAt: Date,
  extra: { latency_ms?: number; deliveredAt?: Date; availableAt?: Date } = {},
) {
  return {
    businessId,
    endpointId,
    topic: "delivery.created",
    payload: { id: randomUUID() },
    signature: "v1=teste",
    status,
    created_at: createdAt,

    // In the future for the rows still in flight, so nothing in this process
    // could ever pick them up while the assertions run.
    availableAt: extra.availableAt ?? new Date(Date.now() + DAY_MS),
    latency_ms: extra.latency_ms ?? null,
    deliveredAt:
      extra.deliveredAt ?? (status === "DELIVERED" ? createdAt : null),
  };
}

let purgedEndpoint = "";
let monitoredEndpoint = "";

beforeAll(async () => {
  purgedEndpoint = await company(PURGED, "Transportadora do Expurgo");
  monitoredEndpoint = await company(MONITORED, "Transportadora do Monitor");

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Administradora do Monitor",
      email: `admin-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: MONITORED,
    },
  });

  token = await tokenFor(ADMIN, MONITORED);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  for (const id of [PURGED, MONITORED]) {
    await prisma.webhookDelivery.deleteMany({ where: { businessId: id } });
    await prisma.webhookEndpoint.deleteMany({ where: { businessId: id } });
  }

  await prisma.refreshToken.deleteMany({ where: { userId: ADMIN } });
  await prisma.user.deleteMany({ where: { id: ADMIN } });
  await prisma.businessEntitlement.deleteMany({
    where: { businessId: { in: [PURGED, MONITORED] } },
  });
  await prisma.business.deleteMany({
    where: { id: { in: [PURGED, MONITORED] } },
  });

  await app?.close();
  await prisma.$disconnect();
});

describe("the nightly purge of the webhook ledger", () => {
  it("removes settled rows past the replay window, and nothing still in flight", async () => {
    const ago = (days: number) => new Date(Date.now() - days * DAY_MS);

    const seeded = {
      deliveredOld: row(PURGED, purgedEndpoint, "DELIVERED", ago(32)),
      failedOld: row(PURGED, purgedEndpoint, "FAILED", ago(32)),

      // Old, but the dispatcher still owns it: a parked row waiting for its
      // endpoint, or one mid-attempt. Age alone never makes it purgeable.
      pendingOld: row(PURGED, purgedEndpoint, "PENDING", ago(32)),
      processingOld: row(PURGED, purgedEndpoint, "PROCESSING", ago(32)),

      // Inside the window, still resendable.
      deliveredRecent: row(PURGED, purgedEndpoint, "DELIVERED", ago(29)),

      // Past the window by hours: no longer resendable, but inside the
      // one-day grace, so a row a person is looking at does not vanish
      // between the listing and the click.
      failedInGrace: row(PURGED, purgedEndpoint, "FAILED", ago(30.5)),
    };

    const ids: Record<string, string> = {};

    for (const [name, data] of Object.entries(seeded)) {
      ids[name] = (
        await prisma.webhookDelivery.create({ data, select: { id: true } })
      ).id;
    }

    const { cleanupWebhookDeliveriesJob } = await import(
      "@/jobs/cron/cleanup-webhook-deliveries-job"
    );

    await cleanupWebhookDeliveriesJob.handler();

    const left = await prisma.webhookDelivery.findMany({
      where: { businessId: PURGED },
      select: { id: true },
    });

    const survivors = new Set(left.map((entry) => entry.id));

    expect(survivors.has(ids.deliveredOld)).toBe(false);
    expect(survivors.has(ids.failedOld)).toBe(false);

    expect(survivors.has(ids.pendingOld)).toBe(true);
    expect(survivors.has(ids.processingOld)).toBe(true);
    expect(survivors.has(ids.deliveredRecent)).toBe(true);
    expect(survivors.has(ids.failedInGrace)).toBe(true);
  });

  it("walks the partial purge index, oldest settled row first", async () => {
    const { settledWebhookDeliveriesBefore } = await import(
      "@/jobs/cron/cleanup-webhook-deliveries-job"
    );

    const cutoff = new Date(Date.now() - 31 * DAY_MS);

    // The batch's inner SELECT, exactly as deleteInBatches builds it. With
    // sequential scans off, the only question left to the planner is WHICH
    // index — and a predicate spelled with bound statuses could not prove
    // the partial one.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");

      return tx.$queryRaw<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (FORMAT JSON)
        SELECT "id" FROM "webhook_delivery"
        WHERE ${settledWebhookDeliveriesBefore(cutoff)}
        ORDER BY "created_at"
        LIMIT 5000
      `;
    });

    const text = JSON.stringify(plan);

    expect(text).toContain("webhook_delivery_purge_idx");
    expect(text).not.toContain('"Node Type":"Sort"');
  });
});

describe("the monitor's counters", () => {
  it("counts a recent window, not the tenant's history, and takes the p95 in SQL", async () => {
    const now = Date.now();

    // A hundred deliveries of the last hours with latencies 1..100 ms. The
    // nearest-rank 95th percentile of that set is 95.
    await prisma.webhookDelivery.createMany({
      data: Array.from({ length: 100 }, (_, index) =>
        row(
          MONITORED,
          monitoredEndpoint,
          "DELIVERED",
          new Date(now - (index + 1) * 60_000),
          { latency_ms: index + 1 },
        ),
      ),
    });

    // Delivered forty days ago: history, not something the screen can act
    // on any more. It must not inflate "Entregues".
    await prisma.webhookDelivery.create({
      data: row(
        MONITORED,
        monitoredEndpoint,
        "DELIVERED",
        new Date(now - 40 * DAY_MS),
        { latency_ms: 5_000 },
      ),
    });

    const response = await app.inject({
      method: "GET",
      url: `/integrations/webhook-deliveries?page=1&pageSize=5&businessId=${MONITORED}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body).toBe(200);

    const envelope = JSON.parse(response.body.split("\n")[0]);
    const meta = envelope.meta.searchMeta;

    expect(meta.delivered).toBe(100);
    expect(meta.p95LatencyMs).toBe(95);
  });
});
