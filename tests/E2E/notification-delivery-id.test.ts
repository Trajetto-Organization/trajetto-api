import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@/shared/database/database-client";
import { deliveryIdFor } from "@/shared/notifications/delivery-id";

/**
 * Re-expanding an event once the unique indexes on (event, recipient,
 * channel) are gone (plano-escala F5-03).
 *
 * Wave 10 (F5-06) drops them: the queues become partitioned by day on
 * their id, and a unique index there must contain the id. This file drops
 * them from its own database, as that release will, and proves the promise
 * they kept still holds through the primary key. Every delivery's id is
 * decided by its event, recipient and channel, so an event expanded again —
 * a retry after a crash, or by a replica that took it over while the first
 * one was still at it — writes the same rows, never a second set.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const BUSINESS = "019a9a40-0000-7000-8000-000000000d01";
const RESPONSIBLE = "019a9a40-0000-7000-8000-000000000d02";
const ACTOR = "019a9a40-0000-7000-8000-000000000d03";

interface ExpandableEvent {
  id: string;
  topic: string;
  payload: unknown;
  businessId: string | null;
  actorId: string | null;
  attempts: number;
  created_at: Date;
  correlationId: string | null;
}

/** The pipeline's private expansion, driven as two replicas would. */
const internals = () =>
  pipeline as unknown as {
    expandEvent: (event: ExpandableEvent) => Promise<void>;
  };

async function publish(): Promise<string> {
  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `account-payable.created:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      actorId: ACTOR,
      payload: {
        accountPayableId: randomUUID(),
        businessId: BUSINESS,
        amount: 150,
        serviceOrderId: null,
        registrationUserId: RESPONSIBLE,
      },
    },
  });

  return event.id;
}

/** Claims the event as one replica would: PROCESSING under a lease. */
async function claim(eventId: string): Promise<ExpandableEvent> {
  const [claimed] = await prisma.$queryRaw<ExpandableEvent[]>`
    UPDATE "domain_outbox_event" SET
      "status" = 'PROCESSING',
      "attempts" = "attempts" + 1,
      "leaseExpiresAt" = now() + interval '60 seconds'
    WHERE "id" = ${eventId}
    RETURNING "id", "topic", "payload", "businessId", "actorId", "attempts",
      "created_at", "correlationId"
  `;

  return claimed;
}

async function deliveriesOf(eventId: string) {
  return prisma.notificationDelivery.findMany({
    where: { outboxEventId: eventId },
    select: {
      id: true,
      userId: true,
      externalRecipientId: true,
      channel: true,
    },
    orderBy: { id: "asc" },
  });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Id da Entrega",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "33444555000181",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `delivery-id-${randomUUID()}@example.com`,
    },
  });

  await prisma.user.createMany({
    data: [
      {
        id: RESPONSIBLE,
        name: "Responsável pela Conta",
        email: `delivery-id-${randomUUID()}@example.com`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: BUSINESS,
      },
      {
        id: ACTOR,
        name: "Quem Lançou a Conta",
        email: `delivery-id-${randomUUID()}@example.com`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: BUSINESS,
      },
    ],
  });

  // A phone in the responsible's pocket: one more channel, one more row.
  await prisma.pushDeviceToken.create({
    data: {
      userId: RESPONSIBLE,
      token: "ExponentPushToken[delivery-id]",
      platform: "android",
    },
  });

  // What the daily partitions of wave 10 will not have.
  await prisma.$executeRawUnsafe(
    `DROP INDEX IF EXISTS "notification_delivery_user_event_channel_idx"`,
  );
  await prisma.$executeRawUnsafe(
    `DROP INDEX IF EXISTS "notification_delivery_external_event_channel_idx"`,
  );

  ({ app } = await import("@/http"));
  await app.ready();

  pipeline = (
    await import("@/shared/notifications/notification-pipeline-service")
  ).NotificationPipelineService.getInstance();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("without the unique indexes on (event, recipient, channel)", () => {
  it("writes every delivery under the id its event, recipient and channel decide", async () => {
    const eventId = await publish();

    await pipeline.runOutboxCycle();

    const event = await prisma.domainOutboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    });
    const rows = await deliveriesOf(eventId);

    expect(event.status).toBe("PUBLISHED");
    // In-app and push for the responsible, the trail entry for the actor.
    expect(rows.map((row) => row.channel)).toEqual(
      expect.arrayContaining(["IN_APP", "PUSH", "ACTIVITY"]),
    );

    for (const row of rows) {
      expect(row.id).toBe(deliveryIdFor(event, row, row.channel));
      // The event's millisecond in front: the event's day partition.
      expect(row.id.slice(0, 13)).toBe(event.id.slice(0, 13));
    }
  });

  it("writes the same rows when the event is expanded again after a crash", async () => {
    const eventId = await publish();

    await pipeline.runOutboxCycle();

    const first = await deliveriesOf(eventId);

    // The worker died after the deliveries committed and the event came
    // back to the queue, as a lease that ran out brings it back.
    await prisma.domainOutboxEvent.update({
      where: { id: eventId },
      data: { status: "PENDING", availableAt: new Date(Date.now() - 1_000) },
    });

    await pipeline.runOutboxCycle();

    const event = await prisma.domainOutboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    });

    expect(event.status).toBe("PUBLISHED");
    expect(event.attempts).toBe(2);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(await deliveriesOf(eventId)).toEqual(first);
  });

  it("writes one set of rows when two replicas expand the event at once", async () => {
    const eventId = await publish();
    const claimed = await claim(eventId);

    // The second replica took the same claim: both get past the lease
    // renewal and run the expansion side by side.
    await Promise.all([
      internals().expandEvent({ ...claimed }),
      internals().expandEvent({ ...claimed }),
    ]);

    const rows = await deliveriesOf(eventId);
    const keys = rows.map(
      (row) => `${row.userId ?? row.externalRecipientId}:${row.channel}`,
    );

    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(keys).size).toBe(rows.length);
    expect(
      (
        await prisma.domainOutboxEvent.findUniqueOrThrow({
          where: { id: eventId },
        })
      ).status,
    ).toBe("PUBLISHED");
  });
});
