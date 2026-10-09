import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient, WebhookDeliveryStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { MONITOR_LIST_CAP } from "@/schemas/integration-schema";

/**
 * The window behind the monitor's cards — and its list.
 *
 * "Entregues" and "Falharam" were grouped over everything the tenant had kept
 * — first its whole history, then the 31 days the purge leaves. At a hundred
 * thousand webhooks a day that is millions of index entries on every open and
 * every "Atualizar", for a number nobody reads as "this month". The cards say
 * what they count: a period, 24 hours by default. "Na fila" is what is still
 * in flight, whatever its age — a row parked for a paused endpoint days ago is
 * exactly the one somebody needs to see.
 *
 * The LIST used to page through the whole retained month beside cards of 24
 * hours, and its "Na fila" chip asked for PENDING alone while the card counted
 * PROCESSING too (DLVB-28, DLVB-29). Now each chip lists exactly what its
 * card counts, in the same period.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const BUSINESS = "018fdc40-0000-7000-8000-00000000000a";
const ADMIN = "018fdc40-0000-7000-8000-0000000000a1";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let token = "";
let endpointId = "";

async function tokenFor(userId: string, businessId: string): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + HOUR_MS),
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

function row(status: WebhookDeliveryStatus, createdAt: Date) {
  return {
    businessId: BUSINESS,
    endpointId,
    topic: "delivery.created",
    payload: { id: randomUUID() },
    signature: "v1=teste",
    status,
    created_at: createdAt,

    // Far in the future, so no dispatcher in this process claims a row
    // while the counters are read.
    availableAt: new Date(Date.now() + 30 * DAY_MS),
    latency_ms: status === "DELIVERED" ? 120 : null,
    deliveredAt: status === "DELIVERED" ? createdAt : null,
  };
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Monitor de 24h",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(56000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `monitor-${randomUUID()}@exemplo.com.br`,
    },
  });

  // Integrations belong to Entregas (decision 4.3).
  await prisma.businessEntitlement.create({
    data: { businessId: BUSINESS, module: "DELIVERIES", enabled: true },
  });

  endpointId = (
    await prisma.webhookEndpoint.create({
      data: {
        name: "ERP",
        url: "https://erp.exemplo.com.br/webhooks",
        secret: "whsec_teste",
        topics: ["delivery.created"],
        businessId: BUSINESS,
      },
    })
  ).id;

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Administradora do Monitor",
      email: `admin-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  token = await tokenFor(ADMIN, BUSINESS);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.refreshToken.deleteMany({ where: { userId: ADMIN } });
  await prisma.user.deleteMany({ where: { id: ADMIN } });
  await prisma.businessEntitlement.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
});

async function monitor(query: string) {
  const response = await app.inject({
    method: "GET",
    url: `/integrations/webhook-deliveries?page=1&pageSize=50&businessId=${BUSINESS}${query}`,
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.statusCode, response.body).toBe(200);

  const [envelopeLine, ...lines] = response.body.split("\n").filter(Boolean);
  const envelope = JSON.parse(envelopeLine);

  return {
    total: envelope.meta.total as number,
    meta: envelope.meta.searchMeta as {
      window: string;
      totalCapped: boolean;
      delivered: number;
      failed: number;
      pending: number;
      p95LatencyMs: number | null;
    },
    rows: lines.map((line) => JSON.parse(line)) as Array<{
      status: string;
      leaseExpiresAt: string | null;
    }>,
  };
}

describe("the monitor's cards and list", () => {
  beforeAll(async () => {
    const ago = (ms: number) => new Date(Date.now() - ms);

    await prisma.webhookDelivery.createMany({
      data: [
        // Today.
        ...Array.from({ length: 20 }, (_, n) =>
          row("DELIVERED", ago((n + 1) * 10 * 60 * 1000)),
        ),
        row("FAILED", ago(2 * HOUR_MS)),
        row("FAILED", ago(5 * HOUR_MS)),

        // Earlier this month: still resendable, not "today".
        ...Array.from({ length: 5 }, () => row("DELIVERED", ago(3 * DAY_MS))),
        ...Array.from({ length: 3 }, () => row("FAILED", ago(10 * DAY_MS))),

        // In flight: one just queued, one parked for a paused endpoint days
        // ago, one being sent, and one whose attempt died with its process
        // (lease already over) and waits to be taken again. All "na fila",
        // whatever their age.
        row("PENDING", ago(5 * 60 * 1000)),
        row("PENDING", ago(5 * DAY_MS)),
        {
          ...row("PROCESSING", ago(60 * 1000)),
          leaseExpiresAt: new Date(Date.now() + 60 * 1000),
        },
        {
          ...row("PROCESSING", ago(2 * DAY_MS)),
          leaseExpiresAt: ago(HOUR_MS),
        },
      ],
    });
  });

  it("count the last 24 hours by default, and everything still in flight", async () => {
    const { meta } = await monitor("");

    expect(meta.window).toBe("24h");
    expect(meta.delivered).toBe(20);
    expect(meta.failed).toBe(2);
    expect(meta.pending).toBe(4);
    expect(meta.p95LatencyMs).toBe(120);
  });

  it("list under Todos exactly what the three cards add up to", async () => {
    // It paged through the whole retained month (37 rows) beside cards of
    // 24 hours (26): the two numbers on one screen disagreed.
    const { total, meta } = await monitor("");

    expect(total).toBe(meta.delivered + meta.failed + meta.pending);
    expect(total).toBe(26);
    expect(meta.totalCapped).toBe(false);
  });

  it("list under Na fila the whole queue the card counts, stalled sends included", async () => {
    // The chip asked for PENDING alone: both PROCESSING rows — the one in
    // flight and the one whose attempt died — were counted and never shown.
    const { total, rows, meta } = await monitor("&status=QUEUED");

    expect(total).toBe(meta.pending);
    expect(rows.map((entry) => entry.status).sort()).toEqual([
      "PENDING",
      "PENDING",
      "PROCESSING",
      "PROCESSING",
    ]);

    const stalled = rows.filter(
      (entry) =>
        entry.status === "PROCESSING" &&
        entry.leaseExpiresAt !== null &&
        new Date(entry.leaseExpiresAt).getTime() < Date.now(),
    );

    expect(stalled).toHaveLength(1);
  });

  it("list a settled status in the card's period", async () => {
    const failed = await monitor("&status=FAILED");

    expect(failed.total).toBe(failed.meta.failed);
    expect(failed.total).toBe(2);

    const delivered = await monitor("&status=DELIVERED");

    expect(delivered.total).toBe(delivered.meta.delivered);
  });

  it("widen cards and list together when a longer period is chosen", async () => {
    const month = await monitor("&window=30d");

    expect(month.meta.window).toBe("30d");
    expect(month.meta.delivered).toBe(25);
    expect(month.meta.failed).toBe(5);
    expect(month.meta.pending).toBe(4);
    expect(month.total).toBe(34);

    const week = await monitor("&window=7d&status=FAILED");

    expect(week.meta.failed).toBe(2);
    expect(week.total).toBe(2);
  });

  it("refuses a period it does not offer", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/integrations/webhook-deliveries?page=1&pageSize=5&businessId=${BUSINESS}&window=1y`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("a list longer than the monitor counts (DLVB-30)", () => {
  let busyEndpointId = "";

  beforeAll(async () => {
    // A second endpoint of the same company, queried by id, so the rows
    // below stay out of the numbers the cases above assert.
    busyEndpointId = (
      await prisma.webhookEndpoint.create({
        data: {
          name: "ERP movimentado",
          url: "https://erp-movimentado.exemplo.com.br/webhooks",
          secret: "whsec_teste",
          topics: ["delivery.created"],
          businessId: BUSINESS,
        },
      })
    ).id;

    // One row past the cap, written in one statement.
    await prisma.$executeRaw`
      INSERT INTO "webhook_delivery" (
        "id", "endpointId", "topic", "payload", "signature", "status",
        "attempts", "availableAt", "latency_ms", "deliveredAt",
        "businessId", "created_at", "updated_at"
      )
      SELECT
        gen_random_uuid()::text, ${busyEndpointId}, 'delivery.created', '{}'::jsonb,
        'v1=teste', 'DELIVERED'::"WebhookDeliveryStatus", 1,
        now() + interval '30 days', 100, now() - interval '30 minutes',
        ${BUSINESS}, now() - interval '30 minutes', now()
      FROM generate_series(1, ${MONITOR_LIST_CAP + 1})
    `;
  }, 120_000);

  it("says the total is a floor and keeps the cards exact", async () => {
    const { total, meta, rows } = await monitor(`&endpointId=${busyEndpointId}`);

    expect(total).toBe(MONITOR_LIST_CAP);
    expect(meta.totalCapped).toBe(true);
    expect(meta.delivered).toBe(MONITOR_LIST_CAP + 1);
    expect(rows).toHaveLength(50);
  });

  it("pages up to the cap and refuses a page past it", async () => {
    const pageSize = 50;
    const lastPage = MONITOR_LIST_CAP / pageSize;

    const last = await app.inject({
      method: "GET",
      url: `/integrations/webhook-deliveries?page=${lastPage}&pageSize=${pageSize}&businessId=${BUSINESS}&endpointId=${busyEndpointId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(last.statusCode, last.body.slice(0, 200)).toBe(200);

    const past = await app.inject({
      method: "GET",
      url: `/integrations/webhook-deliveries?page=${lastPage + 1}&pageSize=${pageSize}&businessId=${BUSINESS}&endpointId=${busyEndpointId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(past.statusCode).toBe(400);
    expect(past.json()).toMatchObject({ code: "MONITOR_PAGE_OUT_OF_RANGE" });
    expect(past.json().message).toContain("10.000");
  });
});
