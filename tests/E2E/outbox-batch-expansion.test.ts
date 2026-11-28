import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { randomUUID } from "node:crypto";

import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";
import { deliveryIdFor } from "@/shared/notifications/delivery-id";
import { getNotificationPolicy } from "@/shared/notifications/notification-policy";

/**
 * The outbox's batch expansion (plano-escala F5-33), against the per-event
 * path it must equal.
 *
 * OUTBOX_EXPANSION_MODE=batch claims 50 events and expands them together:
 * one preference query and one push-device query for all of them, one
 * INSERT of their deliveries and one PUBLISHED mark fenced per event by
 * `UPDATE … FROM (VALUES …)`. It is a new path on the queue every
 * notification goes through, so what it must not change is checked row by
 * row: the same set of events, expanded once per mode, gives the same
 * deliveries (recipient, channel, company and the id their event decides)
 * and leaves every event in the same state, including an event whose
 * policy fails, one with no policy in this build and one whose actor is
 * its only recipient. Then the promises of the queue: no delivery twice
 * when two replicas expand the same batch or an event comes back after a
 * crash, an event another replica took over is not marked by the batch,
 * and a batch whose write fails is written again event by event.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const BUSINESS = "019a9b50-0000-7000-8000-000000000b01";
const ACTOR = "019a9b50-0000-7000-8000-000000000b02";
/** WhatsApp on, a phone, a device; the FINANCE bell turned off. */
const ANA = "019a9b50-0000-7000-8000-000000000b03";
/** No preference row, a device: the legacy toggles decide. */
const BRUNO = "019a9b50-0000-7000-8000-000000000b04";
/** No device; the MAINTENANCE e-mail turned off. */
const CARLA = "019a9b50-0000-7000-8000-000000000b05";

/** A payload the spied policy refuses, as a broken resolver would. */
const BROKEN = "broken-resolver";

interface ClaimedRow {
  id: string;
  topic: string;
  payload: unknown;
  businessId: string | null;
  actorId: string | null;
  attempts: number;
  created_at: Date;
  correlationId: string | null;
  aggregateType: string;
  aggregateId: string;
}

/** The pipeline's private batch expansion, driven as two replicas would. */
const internals = () =>
  pipeline as unknown as {
    expandClaimedBatch: (events: ClaimedRow[]) => Promise<void>;
    preferencesOf: (...args: unknown[]) => Promise<unknown>;
    pushOwnersOf: (...args: unknown[]) => Promise<unknown>;
  };

interface PlannedEvent {
  label: string;
  topic: string;
  aggregateId: string;
  actorId: string | null;
  payload: Record<string, unknown>;
}

/**
 * Twelve events of four topics and three categories: two of one
 * aggregate, the actor as the only recipient, a broken resolver and a
 * topic this build does not know.
 */
function plan(): PlannedEvent[] {
  const orderAggregate = randomUUID();
  const payable = (label: string, registrationUserId: string) => ({
    label,
    topic: "account-payable.created",
    aggregateId: randomUUID(),
    actorId: ACTOR,
    payload: {
      accountPayableId: randomUUID(),
      businessId: BUSINESS,
      amount: 150,
      serviceOrderId: null,
      registrationUserId,
    },
  });
  const order = (
    label: string,
    responsibleUserId: string,
    aggregateId = randomUUID(),
  ) => ({
    label,
    topic: "service-order.created",
    aggregateId,
    actorId: ACTOR,
    payload: {
      serviceOrderId: aggregateId,
      businessId: BUSINESS,
      vehicleId: randomUUID(),
      vehiclePlate: "ABC1D23",
      totalAmount: 320,
      currentMileage: 1000,
      newMileage: null,
      isCompleted: false,
      responsibleUserId,
    },
  });

  return [
    payable("payable-ana", ANA),
    payable("payable-bruno", BRUNO),
    payable("payable-carla", CARLA),
    payable("payable-self", ACTOR),
    order("order-ana", ANA),
    order("order-carla-1", CARLA, orderAggregate),
    order("order-carla-2", CARLA, orderAggregate),
    order("order-bruno", BRUNO),
    {
      label: "fuel",
      topic: "fuel.created",
      aggregateId: randomUUID(),
      actorId: ACTOR,
      payload: {
        fuelId: randomUUID(),
        businessId: BUSINESS,
        vehiclePlate: "ABC1D23",
        vehicleDescription: "Caminhão",
      },
    },
    {
      label: "fuel-platform",
      topic: "fuel.created",
      aggregateId: randomUUID(),
      actorId: null,
      payload: {
        fuelId: randomUUID(),
        businessId: BUSINESS,
        vehiclePlate: "XYZ9Z99",
        vehicleDescription: "Van",
      },
    },
    { ...payable("broken", ANA), payload: { marker: BROKEN } },
    {
      label: "unknown-topic",
      topic: "topic.from-a-newer-build",
      aggregateId: randomUUID(),
      actorId: ACTOR,
      payload: {},
    },
  ];
}

/** The plan as outbox rows, one after the other; label by event id. */
async function publish(events: PlannedEvent[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();

  for (const event of events) {
    const row = await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `${event.topic}:${randomUUID()}`,
        topic: event.topic,
        aggregateType: event.topic.split(".")[0],
        aggregateId: event.aggregateId,
        businessId: BUSINESS,
        actorId: event.actorId,
        payload: event.payload as object,
      },
    });

    labels.set(row.id, event.label);
  }

  return labels;
}

/** What an expansion left behind, with the ids replaced by labels. */
async function outcome(labels: Map<string, string>) {
  const ids = [...labels.keys()];
  const events = await prisma.domainOutboxEvent.findMany({
    where: { id: { in: ids } },
  });
  const deliveries = await prisma.notificationDelivery.findMany({
    where: { outboxEventId: { in: ids } },
  });
  const byId = new Map(events.map((event) => [event.id, event]));

  for (const delivery of deliveries) {
    const event = byId.get(delivery.outboxEventId)!;

    // The id its event, recipient and channel decide, in both modes.
    expect(delivery.id).toBe(deliveryIdFor(event, delivery, delivery.channel));
  }

  return {
    events: events
      .map((event) => ({
        label: labels.get(event.id),
        status: event.status,
        attempts: event.attempts,
        failed: event.lastError !== null,
        processed: event.processedAt !== null,
      }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label))),
    deliveries: deliveries
      .map((delivery) => ({
        label: labels.get(delivery.outboxEventId),
        userId: delivery.userId,
        externalRecipientId: delivery.externalRecipientId,
        channel: delivery.channel,
        business: delivery.business_id,
        status: delivery.status,
      }))
      .sort((a, b) =>
        `${a.label}:${a.userId}:${a.channel}`.localeCompare(
          `${b.label}:${b.userId}:${b.channel}`,
        ),
      ),
  };
}

/** Claims every due event as one replica would: PROCESSING under a lease. */
async function claimAll(ids: string[]): Promise<ClaimedRow[]> {
  return prisma.$queryRaw<ClaimedRow[]>`
    UPDATE "domain_outbox_event" SET
      "status" = 'PROCESSING',
      "attempts" = "attempts" + 1,
      "leaseExpiresAt" = now() + interval '60 seconds',
      "availableAt" = now() + interval '60 seconds'
    WHERE "id" = ANY(${ids}::text[])
    RETURNING "id", "topic", "payload", "businessId", "actorId", "attempts",
      "created_at", "correlationId", "aggregateType", "aggregateId"
  `;
}

/** The events of earlier cases out of the way of the next claim. */
async function settleEverything(): Promise<void> {
  await prisma.domainOutboxEvent.updateMany({
    where: { status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "FAILED", leaseExpiresAt: null },
  });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Lote",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "44555666000172",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `batch-${randomUUID()}@example.com`,
    },
  });

  const person = (id: string, name: string, extra: object = {}) => ({
    id,
    name,
    email: `batch-${randomUUID()}@example.com`,
    password: "nao-usado",
    role: "BUSINESS_ADMIN" as const,
    businessId: BUSINESS,
    ...extra,
  });

  await prisma.user.createMany({
    data: [
      person(ACTOR, "Quem Lançou"),
      person(ANA, "Ana", {
        whatsapp_notifications_enabled: true,
        whatsapp_phone: "5511988887777",
      }),
      person(BRUNO, "Bruno", { email_notifications_enabled: false }),
      person(CARLA, "Carla"),
    ],
  });

  await prisma.pushDeviceToken.createMany({
    data: [
      {
        userId: ANA,
        token: "ExponentPushToken[batch-ana]",
        platform: "android",
      },
      {
        userId: BRUNO,
        token: "ExponentPushToken[batch-bruno]",
        platform: "android",
      },
    ],
  });

  await prisma.notificationPreference.createMany({
    data: [
      { userId: ANA, category: "FINANCE", inApp: false },
      { userId: CARLA, category: "MAINTENANCE", email: false },
    ],
  });

  ({ app } = await import("@/http"));
  await app.ready();

  pipeline = (
    await import("@/shared/notifications/notification-pipeline-service")
  ).NotificationPipelineService.getInstance();

  // A resolver that throws, for one payload only: both modes meet it.
  const policy = getNotificationPolicy("account-payable.created")!;
  const resolve = policy.resolveRecipients.bind(policy);

  vi.spyOn(policy, "resolveRecipients").mockImplementation(
    async (payload, deps) => {
      if ((payload as { marker?: string }).marker === BROKEN) {
        throw new Error("the resolver of this event is broken");
      }

      return resolve(payload, deps);
    },
  );
}, 120_000);

afterEach(() => {
  env.OUTBOX_EXPANSION_MODE = "per-event";
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("OUTBOX_EXPANSION_MODE=batch", () => {
  it("writes the same deliveries and leaves the same events as the per-event path", async () => {
    await settleEverything();

    env.OUTBOX_EXPANSION_MODE = "per-event";
    const perEvent = await publish(plan());
    await pipeline.runOutboxCycle();
    const golden = await outcome(perEvent);

    await settleEverything();

    env.OUTBOX_EXPANSION_MODE = "batch";
    const preferences = vi.spyOn(internals(), "preferencesOf");
    const devices = vi.spyOn(internals(), "pushOwnersOf");
    const batch = await publish(plan());
    await pipeline.runOutboxCycle();
    const batched = await outcome(batch);

    expect(batched).toEqual(golden);

    // Something to compare: every topic's channels, the failure and the
    // deferral are in the golden.
    expect(golden.deliveries.map((row) => row.channel)).toEqual(
      expect.arrayContaining([
        "IN_APP",
        "PUSH",
        "WHATSAPP",
        "EMAIL",
        "ACTIVITY",
      ]),
    );
    expect(golden.events.find((e) => e.label === "broken")).toMatchObject({
      status: "PENDING",
      failed: true,
    });
    expect(
      golden.events.find((e) => e.label === "unknown-topic"),
    ).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(golden.events.filter((e) => e.status === "PUBLISHED")).toHaveLength(
      10,
    );
    // The actor is not told of what they did: only the trail entry.
    expect(
      golden.deliveries
        .filter((row) => row.label === "payable-self")
        .map((row) => row.channel),
    ).toEqual(["ACTIVITY"]);

    // One claim of the twelve: one lookup of each kind for all of them.
    expect(preferences).toHaveBeenCalledTimes(1);
    expect(devices).toHaveBeenCalledTimes(1);

    preferences.mockRestore();
    devices.mockRestore();
  });

  it("writes one set of rows when two replicas expand the same batch at once", async () => {
    await settleEverything();
    env.OUTBOX_EXPANSION_MODE = "batch";

    const labels = await publish(plan().slice(0, 8));
    const claimed = await claimAll([...labels.keys()]);

    await Promise.all([
      internals().expandClaimedBatch(claimed.map((row) => ({ ...row }))),
      internals().expandClaimedBatch(claimed.map((row) => ({ ...row }))),
    ]);

    const { events, deliveries } = await outcome(labels);
    const keys = deliveries.map(
      (row) =>
        `${row.label}:${row.userId ?? row.externalRecipientId}:${row.channel}`,
    );

    expect(deliveries.length).toBeGreaterThan(8);
    expect(new Set(keys).size).toBe(deliveries.length);
    expect(events.every((event) => event.status === "PUBLISHED")).toBe(true);
  });

  it("writes nothing new when the batch comes back after a crash", async () => {
    await settleEverything();
    env.OUTBOX_EXPANSION_MODE = "batch";

    const labels = await publish(plan().slice(0, 8));

    await pipeline.runOutboxCycle();

    const first = await outcome(labels);

    // The worker died after the commit, and the lease brought them back.
    await prisma.domainOutboxEvent.updateMany({
      where: { id: { in: [...labels.keys()] } },
      data: { status: "PENDING", availableAt: new Date(Date.now() - 1_000) },
    });

    await pipeline.runOutboxCycle();

    const again = await outcome(labels);

    expect(again.deliveries).toEqual(first.deliveries);
    expect(again.events.every((event) => event.attempts === 2)).toBe(true);
    expect(again.events.every((event) => event.status === "PUBLISHED")).toBe(
      true,
    );
  });

  it("leaves an event another replica took over to its new owner", async () => {
    await settleEverything();
    env.OUTBOX_EXPANSION_MODE = "batch";

    const labels = await publish(plan().slice(0, 4));
    const claimed = await claimAll([...labels.keys()]);
    const taken = claimed[0];

    // Its lease ran out and another replica claimed it: the attempt moved.
    await prisma.domainOutboxEvent.update({
      where: { id: taken.id },
      data: { attempts: { increment: 1 } },
    });

    await internals().expandClaimedBatch(claimed);

    const rows = await prisma.domainOutboxEvent.findMany({
      where: { id: { in: [...labels.keys()] } },
    });

    for (const row of rows) {
      if (row.id === taken.id) {
        expect(row.status).toBe("PROCESSING");
        expect(row.attempts).toBe(taken.attempts + 1);
        expect(row.processedAt).toBeNull();
      } else {
        expect(row.status).toBe("PUBLISHED");
      }
    }
  });

  it("writes a batch again event by event when its write fails, so only the bad event retries", async () => {
    await settleEverything();
    env.OUTBOX_EXPANSION_MODE = "batch";

    const labels = await publish(plan().slice(0, 4));
    const [bad] = [...labels].find(([, label]) => label === "payable-bruno")!;

    // The database refuses the deliveries of one event, as a constraint
    // would: the batch's INSERT carries them, so the whole batch fails.
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS e2e_refused_event ("id" text PRIMARY KEY)`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO e2e_refused_event ("id") VALUES ('${bad}')`,
    );
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION e2e_refuse_delivery() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF EXISTS (SELECT 1 FROM e2e_refused_event WHERE "id" = NEW."outboxEventId") THEN
          RAISE EXCEPTION 'delivery refused by the test';
        END IF;
        RETURN NEW;
      END
      $fn$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER e2e_refuse_delivery BEFORE INSERT ON "notification_delivery"
      FOR EACH ROW EXECUTE FUNCTION e2e_refuse_delivery()`);

    try {
      await pipeline.runOutboxCycle();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS e2e_refuse_delivery ON "notification_delivery"`,
      );
    }

    const { events, deliveries } = await outcome(labels);

    for (const event of events) {
      if (event.label === "payable-bruno") {
        // Its own failure: back to the queue with a backoff, one attempt.
        expect(event).toMatchObject({
          status: "PENDING",
          attempts: 1,
          failed: true,
        });
      } else {
        expect(event).toMatchObject({ status: "PUBLISHED", attempts: 1 });
      }
    }

    expect(deliveries.some((row) => row.label === "payable-bruno")).toBe(false);
    expect(new Set(deliveries.map((row) => row.label))).toEqual(
      new Set(["payable-ana", "payable-carla", "payable-self"]),
    );
  });
});
