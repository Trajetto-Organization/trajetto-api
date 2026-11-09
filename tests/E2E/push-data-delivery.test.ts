import "@/shared";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";

// The phone is the only thing faked: the pipeline renders and routes for
// real, and what it hands Expo is recorded here.
const expo = vi.hoisted(() => ({
  sent: [] as Array<{ tokens: string[]; content: Record<string, unknown> }>,
}));

vi.mock("@/shared/notifications/push-provider", () => ({
  sendExpoPushMessages: async (
    tokens: string[],
    content: Record<string, unknown>,
  ) => {
    expo.sent.push({ tokens, content });

    return { deliveredAny: true, invalidTokens: [], tickets: [] };
  },
  fetchExpoPushReceipts: async () => [],
}));

vi.mock("@/websocket", () => ({
  sendNotificationToUser: vi.fn(),
}));

import { NotificationPipelineService } from "@/shared/notifications/notification-pipeline-service";
import { OutboxService } from "@/shared/notifications/outbox-service";

import {
  seedFleetDriver,
  seedUser,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * The push names the item, its company and its recipient (wave 3), from
 * the event to what Expo receives.
 *
 * The tray message and the inbox row are separate deliveries, so the push
 * carried only `{url, link, type}`: the app could open the notifications
 * screen and nothing else. Now `entityId`, `businessId` and `userId` ride
 * along — the same `entityId` and `businessId` as the inbox row — and the
 * old keys stay for the builds that read only `url`. Ids only.
 */
const prisma = createPrismaClient();

const FLEET = "018fe800-0000-7000-8000-00000000000f";

let fleet: FleetDriverSeed;

type PushData = Record<string, unknown>;

async function drainNotifications(): Promise<void> {
  const notifications = NotificationPipelineService.getInstance();

  await notifications.runOutboxCycle();
  await notifications.runDeliveryCycle("internal");
  await notifications.runDeliveryCycle("external");
}

async function publish(
  topic: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `${topic}:${randomUUID()}`,
      topic,
      aggregateType,
      aggregateId,
      businessId: FLEET,
      payload: payload as never,
    },
  });
}

function pushOf(type: string): PushData | undefined {
  return expo.sent
    .map((entry) => entry.content.data as PushData)
    .find((data) => data.type === type);
}

beforeAll(async () => {
  vi.spyOn(OutboxService.prototype as never, "wakePipeline").mockImplementation(
    (() => undefined) as never,
  );

  fleet = await seedFleetDriver(prisma, {
    businessId: FLEET,
    cnpj: "63777888000190",
  });

  await prisma.pushDeviceToken.create({
    data: {
      userId: fleet.driverUserId,
      token: "ExponentPushToken[driver]",
      platform: "android",
    },
  });
}, 90_000);

beforeEach(() => {
  expo.sent = [];
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

describe("the push of an in-app notification", () => {
  it("names the service order, its company and the driver it was sent to", async () => {
    const serviceOrderId = randomUUID();

    await publish("service-order.created", "service-order", serviceOrderId, {
      serviceOrderId,
      businessId: FLEET,
      vehicleId: fleet.vehicleId,
      vehiclePlate: "ABC1D23",
      totalAmount: 1850,
      currentMileage: 1_000,
      newMileage: null,
      isCompleted: false,
      responsibleUserId: fleet.driverUserId,
    });

    await drainNotifications();

    const data = pushOf("service-order");

    expect(data).toEqual({
      url: "/notifications",
      link: expect.stringContaining(
        `/driver/vehicles/${fleet.vehicleId}/service-orders`,
      ),
      type: "service-order",
      entityId: serviceOrderId,
      businessId: FLEET,
      userId: fleet.driverUserId,
      deliveryId: expect.any(String),
    });

    // The same coordinates as the inbox row the app compares it with.
    const row = await prisma.notification.findFirstOrThrow({
      where: { userId: fleet.driverUserId, entityId: serviceOrderId },
    });

    expect(row).toMatchObject({
      type: "service-order",
      entityId: data?.entityId,
      businessId: data?.businessId,
    });

    // Ids only: no amount, plate or name reaches the lock screen as data.
    expect(JSON.stringify(data)).not.toContain("1850");
    expect(JSON.stringify(data)).not.toContain("ABC1D23");
  });

  it("names the Kanban card the driver is designated to", async () => {
    const cardId = randomUUID();

    await publish("kanban-card.created", "kanban-card", cardId, {
      cardId,
      businessId: FLEET,
      title: "Levar à revisão",
      description: null,
      priority: "high",
      dueDate: null,
      isCompleted: false,
      assignedUserId: fleet.driverUserId,
      fromServiceOrder: false,
    });

    await drainNotifications();

    expect(pushOf("kanban-card")).toMatchObject({
      url: "/notifications",
      type: "kanban-card",
      entityId: cardId,
      businessId: FLEET,
      userId: fleet.driverUserId,
    });
  });
});

/**
 * The tower's authorization request, marked for the app (wave 4).
 *
 * Its notice keeps `type: "delivery"` and the delivery as `entityId` — the
 * web, the builds in the field and read-by-entity read them so — and the
 * push adds `kind: "occurrence-authorization"` and the `occurrenceId` the
 * decision endpoint needs (its company is the push's `businessId`). The inbox
 * row has no free-form column and stays as it was.
 */
describe("the push of the tower's authorization request", () => {
  it("carries the kind and the occurrence beside the row's coordinates", async () => {
    const admin = await seedUser(prisma, FLEET, "BUSINESS_ADMIN");

    await prisma.pushDeviceToken.create({
      data: {
        userId: admin.id,
        token: "ExponentPushToken[tower]",
        platform: "android",
      },
    });

    const shipper = await prisma.shipper.create({
      data: {
        name: `Embarcador ${randomUUID().slice(0, 6)}`,
        businessId: FLEET,
      },
    });

    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Mercado Central",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        status: "IN_TRANSIT",
        driverId: fleet.driverId,
        businessId: FLEET,
        shipperId: shipper.id,
      },
    });

    const type = await prisma.occurrenceType.create({
      data: {
        name: "Cliente ausente (torre)",
        blocks_delivery: true,
        requires_authorization: true,
        businessId: FLEET,
      },
    });

    // Waiting and live: the delivery is with the reporting driver, on no
    // route, and nothing moved it since.
    const occurrence = await prisma.deliveryOccurrence.create({
      data: {
        deliveryId: delivery.id,
        businessId: FLEET,
        occurrenceTypeId: type.id,
        reportedById: fleet.driverUserId,
        authorization_status: "PENDING",
      },
    });

    await publish(
      "delivery-occurrence.authorization_requested",
      "delivery",
      delivery.id,
      {
        occurrenceId: occurrence.id,
        deliveryId: delivery.id,
        businessId: FLEET,
        recipientName: "Mercado Central",
        occurrenceTypeName: "Cliente ausente (torre)",
        blocksDelivery: true,
        description: null,
        reporterName: "Motorista da Frota",
        fromDriver: true,
        photosCount: 0,
        answers: [],
        requestedAt: new Date().toISOString(),
        category: "NOT_DELIVERED",
      },
    );

    await drainNotifications();

    const sent = expo.sent.find((entry) =>
      entry.tokens.includes("ExponentPushToken[tower]"),
    );

    expect(sent?.content.data).toEqual({
      url: "/notifications",
      link: expect.stringContaining("/dashboard/control-tower"),
      type: "delivery",
      entityId: delivery.id,
      kind: "occurrence-authorization",
      occurrenceId: occurrence.id,
      businessId: FLEET,
      userId: admin.id,
      deliveryId: expect.any(String),
    });

    // The inbox row keeps today's coordinates: no column for the marker.
    const row = await prisma.notification.findFirstOrThrow({
      where: { userId: admin.id, entityId: delivery.id },
    });

    expect(row).toMatchObject({
      type: "delivery",
      entityId: delivery.id,
      businessId: FLEET,
    });
  });
});
