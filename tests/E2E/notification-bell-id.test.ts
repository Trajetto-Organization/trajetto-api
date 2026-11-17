import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@/shared/database/database-client";
import { getNotificationPolicy } from "@/shared/notifications/notification-policy";

/**
 * The bell once the unique on notification.deliveryId is gone
 * (plano-escala F5-14).
 *
 * The bell becomes a table partitioned by month on its id (F5-15), and the
 * global unique on deliveryId cannot stay there. This file drops it from
 * its own database, as that release will, and proves the IN_APP channel
 * stays idempotent through the primary key: the notification's id IS the
 * delivery's, so a delivery sent again after a crash, or by two workers at
 * once, rings the bell once.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const BUSINESS = "019a9a70-0000-7000-8000-000000000b01";
const USER = "019a9a70-0000-7000-8000-000000000b02";

/** An IN_APP delivery of a fresh event, due now. */
async function queueInApp(): Promise<{
  deliveryId: string;
  payload: Record<string, unknown>;
}> {
  const payload = {
    accountPayableId: randomUUID(),
    businessId: BUSINESS,
    amount: 150,
    serviceOrderId: null,
    registrationUserId: USER,
  };

  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `bell-id:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      status: "PUBLISHED",
      processedAt: new Date(),
      payload,
    },
  });

  const delivery = await prisma.notificationDelivery.create({
    data: {
      outboxEventId: event.id,
      userId: USER,
      channel: "IN_APP",
      availableAt: new Date(Date.now() - 1_000),
    },
  });

  return { deliveryId: delivery.id, payload };
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Sino",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "77888999000154",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `bell-id-${randomUUID()}@example.com`,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa do Sino",
      email: `bell-id-${randomUUID()}@example.com`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  // What the monthly partitions of the bell (F5-15) will not have.
  await prisma.$executeRawUnsafe(
    `DROP INDEX IF EXISTS "notification_deliveryId_key"`,
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

describe("without the unique on notification.deliveryId", () => {
  it("rings the bell once, under the delivery's id, when the delivery is sent again", async () => {
    const { deliveryId } = await queueInApp();

    await pipeline.runDeliveryCycle("internal");

    // The worker died after the bell row and before the DELIVERED mark:
    // the lease runs out and the row is sent again.
    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "PENDING",
        availableAt: new Date(Date.now() - 1_000),
      },
    });

    await pipeline.runDeliveryCycle("internal");

    const rows = await prisma.notification.findMany({
      where: { deliveryId },
      select: { id: true },
    });

    expect(rows).toEqual([{ id: deliveryId }]);
    expect(
      (
        await prisma.notificationDelivery.findUniqueOrThrow({
          where: { id: deliveryId },
        })
      ).status,
    ).toBe("DELIVERED");
  });

  it("rings the bell once when two workers send the same delivery at once", async () => {
    const { deliveryId, payload } = await queueInApp();

    const internals = pipeline as unknown as {
      deliverInApp: (
        delivery: { id: string; userId: string; channel: "IN_APP" },
        payload: unknown,
        policy: unknown,
        event: { businessId: string | null },
      ) => Promise<undefined>;
    };

    const policy = getNotificationPolicy("account-payable.created");
    const delivery = {
      id: deliveryId,
      userId: USER,
      channel: "IN_APP" as const,
    };

    await Promise.all([
      internals.deliverInApp({ ...delivery }, payload, policy, {
        businessId: BUSINESS,
      }),
      internals.deliverInApp({ ...delivery }, payload, policy, {
        businessId: BUSINESS,
      }),
      internals.deliverInApp({ ...delivery }, payload, policy, {
        businessId: BUSINESS,
      }),
    ]);

    expect(
      await prisma.notification.findMany({
        where: { deliveryId },
        select: { id: true },
      }),
    ).toEqual([{ id: deliveryId }]);
  });
});
