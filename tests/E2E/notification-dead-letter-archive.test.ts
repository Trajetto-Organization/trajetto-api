import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { cleanupNotificationPipelineJob } from "@/jobs/cron/cleanup-notification-pipeline-job";

/**
 * A failed delivery outlives the 30-day purge (OUTBOX-18, OBS-16).
 *
 * Deliveries live and die with their outbox event, and the nightly purge
 * deletes PUBLISHED events 30 days after processing. The cascade took their
 * FAILED deliveries — and the providerMessageId, the one piece of evidence
 * that tells "we sent it twice" from "they received it twice" — while the
 * code and the docs promised 90 days for failures: that number only ever
 * applied to events that failed to fan out. A customer asking about a
 * message from five weeks ago found nothing.
 *
 * Now the job copies each FAILED delivery to notification_dead_letter before
 * the purge, and the archive keeps it 90 days.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const MASTER = "018fda80-0000-7000-8000-0000000000m1";
const CARRIER = "018fda80-0000-7000-8000-00000000000a";

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

let token = "";

async function publishedEvent(processedDaysAgo: number) {
  return prisma.domainOutboxEvent.create({
    data: {
      eventKey: `archive-${randomUUID()}`,
      topic: "delivery.dispatched",
      aggregateType: "delivery",
      aggregateId: randomUUID(),
      businessId: CARRIER,
      payload: {},
      status: "PUBLISHED",
      processedAt: daysAgo(processedDaysAgo),
      created_at: daysAgo(processedDaysAgo),
    },
  });
}

let oldEvent = "";
let oldFailed = "";
let oldDelivered = "";
let cleanEvent = "";
let recentEvent = "";
let recentFailed = "";
let expiredArchive = "";

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Arquivo",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(57000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `archive-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: MASTER,
      name: "Master do Arquivo",
      email: `master-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "MASTER",
    },
  });

  // Processed 31 days ago: one WhatsApp that Meta accepted, one that failed.
  const old = await publishedEvent(31);
  oldEvent = old.id;

  oldDelivered = (
    await prisma.notificationDelivery.create({
      data: {
        outboxEventId: old.id,
        userId: MASTER,
        channel: "EMAIL",
        status: "DELIVERED",
        providerMessageId: "resend-ok",
        created_at: daysAgo(31),
        updated_at: daysAgo(31),
      },
    })
  ).id;

  oldFailed = (
    await prisma.notificationDelivery.create({
      data: {
        outboxEventId: old.id,
        userId: MASTER,
        channel: "WHATSAPP",
        status: "FAILED",
        attempts: 5,
        lastError: "boom",
        providerMessageId: "wamid.X",
        created_at: daysAgo(31),
        updated_at: daysAgo(31),
      },
    })
  ).id;

  // Processed 31 days ago, nothing failed: purged, nothing to keep.
  const clean = await publishedEvent(31);
  cleanEvent = clean.id;

  await prisma.notificationDelivery.create({
    data: {
      outboxEventId: clean.id,
      userId: MASTER,
      channel: "IN_APP",
      status: "DELIVERED",
    },
  });

  // Yesterday's failure: its event is not due for the purge, so it stays
  // where it is and is not archived yet.
  const recent = await publishedEvent(1);
  recentEvent = recent.id;

  recentFailed = (
    await prisma.notificationDelivery.create({
      data: {
        outboxEventId: recent.id,
        userId: MASTER,
        channel: "EMAIL",
        status: "FAILED",
        attempts: 5,
        lastError: "550 recusado",
      },
    })
  ).id;

  // An archived failure past its 90 days.
  expiredArchive = randomUUID();

  await prisma.notificationDeadLetter.create({
    data: {
      id: expiredArchive,
      outboxEventId: randomUUID(),
      topic: "delivery.dispatched",
      businessId: CARRIER,
      userId: MASTER,
      channel: "EMAIL",
      attempts: 5,
      created_at: daysAgo(92),
      failedAt: daysAgo(91),
    },
  });

  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId: MASTER,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  token = sign(
    {
      tokenType: "access",
      role: "MASTER",
      businessId: null,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: MASTER, expiresIn: "1h" },
  );

  ({ app } = await import("@/http"));
  await app.ready();

  await cleanupNotificationPipelineJob.handler();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("the nightly purge", () => {
  it("still removes the old events and their deliveries", async () => {
    expect(
      await prisma.domainOutboxEvent.count({
        where: { id: { in: [oldEvent, cleanEvent] } },
      }),
    ).toBe(0);

    expect(
      await prisma.notificationDelivery.count({
        where: { id: { in: [oldFailed, oldDelivered] } },
      }),
    ).toBe(0);
  });

  it("but the failed delivery is archived first, with its evidence", async () => {
    const archived = await prisma.notificationDeadLetter.findUnique({
      where: { id: oldFailed },
    });

    expect(archived).toMatchObject({
      outboxEventId: oldEvent,
      topic: "delivery.dispatched",
      businessId: CARRIER,
      userId: MASTER,
      channel: "WHATSAPP",
      attempts: 5,
      lastError: "boom",
      providerMessageId: "wamid.X",
    });

    // Only failures are archived.
    expect(
      await prisma.notificationDeadLetter.findUnique({
        where: { id: oldDelivered },
      }),
    ).toBeNull();
  });

  it("leaves a recent failure where it is", async () => {
    expect(
      await prisma.domainOutboxEvent.count({ where: { id: recentEvent } }),
    ).toBe(1);

    expect(
      await prisma.notificationDelivery.count({ where: { id: recentFailed } }),
    ).toBe(1);

    expect(
      await prisma.notificationDeadLetter.findUnique({
        where: { id: recentFailed },
      }),
    ).toBeNull();
  });

  it("and drops archived failures after 90 days", async () => {
    expect(
      await prisma.notificationDeadLetter.findUnique({
        where: { id: expiredArchive },
      }),
    ).toBeNull();
  });

  it("archiving twice is harmless", async () => {
    await cleanupNotificationPipelineJob.handler();

    expect(
      await prisma.notificationDeadLetter.count({ where: { id: oldFailed } }),
    ).toBe(1);
  });
});

describe("GET /health/dead-letter?source=archive", () => {
  it("lists the archived failure five weeks later", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/dead-letter?source=archive",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);

    const row = response
      .json()
      .data.find((entry: { id: string }) => entry.id === oldFailed);

    expect(row).toMatchObject({
      channel: "WHATSAPP",
      topic: "delivery.dispatched",
      businessId: CARRIER,
      lastError: "boom",
    });
  });

  it("never shows a recipient's address, even in rows stored before the redaction", async () => {
    // Written by an older release, whose error text carried the recipient.
    const legacy = await prisma.notificationDelivery.create({
      data: {
        outboxEventId: recentEvent,
        userId: MASTER,
        channel: "WHATSAPP",
        status: "FAILED",
        attempts: 5,
        lastError:
          "Falha ao enviar e-mail para cliente.final@exemplo.com.br: 550 5.1.1 <cliente.final@exemplo.com.br>",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/dead-letter",
      headers: { authorization: `Bearer ${token}` },
    });

    const row = response
      .json()
      .data.find((entry: { id: string }) => entry.id === legacy.id);

    expect(row.lastError).not.toContain("cliente.final@exemplo.com.br");
    expect(row.lastError).toContain("c***@exemplo.com.br");
  });

  it("and the live dead letter still answers as before", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/dead-letter",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);

    const ids = response.json().data.map((entry: { id: string }) => entry.id);

    expect(ids).toContain(recentFailed);
    expect(ids).not.toContain(oldFailed);
  });
});
