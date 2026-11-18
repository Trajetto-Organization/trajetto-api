import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import { v7 as uuidV7 } from "uuid";

import { cleanupNotificationPipelineJob } from "@/jobs/cron/cleanup-notification-pipeline-job";
import { maintainPartitions } from "@/jobs/cron/partition-maintenance-job";
import { createPrismaClient } from "@/shared/database/database-client";
import { readPartitionStates } from "@/shared/health/operational-state";
import { deliveryIdFor } from "@/shared/notifications/delivery-id";
import {
  createNotificationFamilyGate,
  notificationFamilyLegacyBound,
} from "@/shared/notifications/notification-family-retention";
import { receiptIdFor } from "@/shared/notifications/receipt-id";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

import { unpartitionQueues } from "./support/queue-partitions";

/**
 * The notification family leaves by day (plano-escala F5-11), on a real
 * Postgres whose queues the swap of F5-09 partitioned: the
 * partition-maintenance job detaches and drops a day of events, deliveries
 * and receipts past OUTBOX_PUBLISHED_RETENTION_DAYS, through the
 * notification-family gate.
 *
 * Why each case: a day dropped with a row in flight loses a message
 * nobody sent; a FAILED event or delivery dropped without its dead letter
 * is a failure support can no longer explain or replay; a key left behind
 * says "already published" for an event that is gone, and one taken from a
 * FAILED event would let its replay publish twice. And the purge in
 * batches must keep away from the days the DROP takes: a DELETE there is
 * the dead rows and the WAL the partitions exist to avoid.
 */
const prisma = createPrismaClient();
const DAY_MS = 24 * 60 * 60 * 1000;

const startOfUtcDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
const TOMORROW = startOfUtcDay(Date.now()) + DAY_MS;
const stamp = (ms: number) =>
  new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

/** Forty days on: the week the swap made is past the 30 days. */
const LATER = new Date(TOMORROW + 40 * DAY_MS + 4 * 3_600_000);

let userId: string;
let businessId: string;

const ids: Record<string, string> = {};

afterAll(async () => {
  await prisma.$disconnect();
});

async function event(
  name: string,
  at: number,
  data: { status: "PENDING" | "PUBLISHED" | "FAILED"; processedAt?: Date },
): Promise<{ id: string; created_at: Date }> {
  const id = uuidV7({ msecs: at });
  const created = await prisma.domainOutboxEvent.create({
    data: {
      id,
      eventKey: `family:${name}:${randomUUID()}`,
      topic: "delivery.created",
      aggregateType: "delivery",
      aggregateId: randomUUID(),
      businessId,
      payload: {},
      status: data.status,
      processedAt: data.processedAt ?? null,
      attempts: data.status === "FAILED" ? 5 : 0,
      lastError: data.status === "FAILED" ? "expansão falhou" : null,
      created_at: new Date(at),
    },
    select: { id: true, created_at: true, eventKey: true },
  });

  ids[name] = created.id;
  await prisma.outboxEventKey.create({
    data: {
      event_key: created.eventKey,
      event_id: created.id,
      created_at: new Date(at),
    },
  });

  return created;
}

async function delivery(
  name: string,
  of: { id: string; created_at: Date },
  channel: "EMAIL" | "IN_APP",
  status: "PENDING" | "DELIVERED" | "FAILED",
): Promise<string> {
  const id = deliveryIdFor(of, { userId }, channel);

  await prisma.notificationDelivery.create({
    data: {
      id,
      outboxEventId: of.id,
      userId,
      channel,
      status,
      attempts: status === "FAILED" ? 5 : 1,
      lastError: status === "FAILED" ? "550 recusado" : null,
      business_id: businessId,
    },
  });
  ids[name] = id;

  return id;
}

async function count(table: string, id: string): Promise<number> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT count(*)::int AS count FROM "${table}" WHERE "id" = $1`,
    id,
  );

  return row.count;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      name: "Destinatária da Família",
      email: `family-${randomUUID()}@example.com`,
      password: "nao-usado",
      role: "MASTER",
    },
  });
  const business = await prisma.business.create({
    data: {
      corporate_reason: "Transportadora da Família",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222999000351",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `family-business-${randomUUID()}@example.com`,
    },
  });

  userId = user.id;
  businessId = business.id;

  const old = new Date(Date.now() - 40 * DAY_MS);

  // Today, in the legacy partition: an event published long ago.
  const legacy = await event("legacyEvent", Date.now() - 60_000, {
    status: "PUBLISHED",
    processedAt: old,
  });
  await delivery("legacyDelivery", legacy, "IN_APP", "DELIVERED");

  // Tomorrow's day: a published event with a failed e-mail and its
  // receipt, a failed event whose e-mail went out, and one published long
  // ago (the purge in batches must leave it to the DROP).
  const published = await event("published", TOMORROW + 3_600_000, {
    status: "PUBLISHED",
    processedAt: new Date(),
  });
  await delivery("delivered", published, "IN_APP", "DELIVERED");
  const failed = await delivery("failedEmail", published, "EMAIL", "FAILED");

  const receipt = {
    deliveryId: failed,
    provider: "resend",
    providerMessageId: `email-${randomUUID()}`,
    status: "bounced",
    occurredAt: new Date(),
  };

  await prisma.notificationProviderReceipt.create({
    data: { id: receiptIdFor(receipt), ...receipt },
  });
  ids.receipt = receiptIdFor(receipt);

  const gaveUp = await event("failedEvent", TOMORROW + 7_200_000, {
    status: "FAILED",
  });
  await delivery("gaveUpEmail", gaveUp, "EMAIL", "DELIVERED");

  const longAgo = await event("dayPublishedLongAgo", TOMORROW + 9_000_000, {
    status: "PUBLISHED",
    processedAt: old,
  });
  await delivery("longAgoDelivery", longAgo, "IN_APP", "DELIVERED");

  // The day after: an event still waiting to be expanded.
  const waiting = await event("waiting", TOMORROW + DAY_MS + 3_600_000, {
    status: "PENDING",
  });
  await delivery("waitingEmail", waiting, "EMAIL", "PENDING");
});

describe("the purge in batches on the partitioned family", () => {
  it("reaches only the legacy partitions, leaving the days to the DROP", async () => {
    expect(await notificationFamilyLegacyBound(prisma)).toBe(
      uuid7Floor(TOMORROW),
    );

    await cleanupNotificationPipelineJob.handler();

    // Both were published 40 days ago; only the legacy one went.
    expect(await count("domain_outbox_event", ids.legacyEvent)).toBe(0);
    expect(await count("notification_delivery", ids.legacyDelivery)).toBe(0);
    expect(await count("domain_outbox_event", ids.dayPublishedLongAgo)).toBe(1);
    expect(await count("notification_delivery", ids.longAgoDelivery)).toBe(1);
  });
});

describe("a day of the family past the retention", () => {
  let elapsedMs = 0;

  beforeAll(async () => {
    const started = Date.now();

    await maintainPartitions({ now: LATER });
    elapsedMs = Date.now() - started;
  }, 120_000);

  it("leaves whole, the three tables' partitions gone, in under a minute", async () => {
    for (const table of [
      "domain_outbox_event",
      "notification_delivery",
      "notification_provider_receipt",
    ]) {
      const [row] = await prisma.$queryRaw<
        Array<{ legacy: boolean; day: boolean }>
      >`
        SELECT to_regclass(quote_ident(${`${table}_legacy`})) IS NOT NULL AS legacy,
               to_regclass(quote_ident(${`${table}_${stamp(TOMORROW)}`})) IS NOT NULL AS day
      `;

      expect(row, table).toEqual({ legacy: false, day: false });
    }

    expect(await count("domain_outbox_event", ids.published)).toBe(0);
    expect(await count("notification_delivery", ids.failedEmail)).toBe(0);
    expect(await count("notification_provider_receipt", ids.receipt)).toBe(0);
    expect(elapsedMs).toBeLessThan(60_000);
  });

  it("copied its failures to the dead letters first", async () => {
    const deadEvent = await prisma.outboxEventDeadLetter.findUnique({
      where: { id: ids.failedEvent },
    });

    expect(deadEvent).toMatchObject({ topic: "delivery.created", businessId });
    // What its deliveries settled, for the replay to skip.
    expect(deadEvent?.settled_deliveries).toEqual([
      expect.objectContaining({
        userId,
        channel: "EMAIL",
        status: "DELIVERED",
      }),
    ]);

    expect(
      await prisma.notificationDeadLetter.findUnique({
        where: { id: ids.failedEmail },
      }),
    ).toMatchObject({
      outboxEventId: ids.published,
      topic: "delivery.created",
      businessId,
      channel: "EMAIL",
    });
  });

  it("dropped the keys of its published events and kept the failed one's", async () => {
    const keys = await prisma.outboxEventKey.findMany({
      where: {
        event_id: {
          in: [ids.legacyEvent, ids.published, ids.failedEvent, ids.waiting],
        },
      },
      select: { event_id: true },
    });

    expect(keys.map((key) => key.event_id).sort()).toEqual(
      [ids.failedEvent, ids.waiting].sort(),
    );
  });

  it("keeps the day with a row in flight, and says it is stuck after the grace", async () => {
    const day = stamp(TOMORROW + DAY_MS);

    for (const table of [
      "domain_outbox_event",
      "notification_delivery",
      "notification_provider_receipt",
    ]) {
      const [row] = await prisma.$queryRaw<Array<{ present: boolean }>>`
        SELECT to_regclass(quote_ident(${`${table}_${day}`})) IS NOT NULL AS present
      `;

      expect(row.present, table).toBe(true);
    }

    expect(await count("domain_outbox_event", ids.waiting)).toBe(1);
    expect(await count("notification_delivery", ids.waitingEmail)).toBe(1);

    const states = await readPartitionStates(LATER);

    expect(states.domain_outbox_event.stuck).toEqual([
      `domain_outbox_event_${day}`,
    ]);

    // The batches' bound moved up to the day that is left.
    expect(await notificationFamilyLegacyBound(prisma)).toBe(
      uuid7Floor(TOMORROW + DAY_MS),
    );
  });

  it("keeps every day while one of the three is still a plain table", async () => {
    await unpartitionQueues(["notification_provider_receipt"]);

    const gate = createNotificationFamilyGate({
      db: prisma,
      deadline: Date.now() + 60_000,
      failedRetentionDays: 90,
    });

    expect(
      await gate.mayDrop("domain_outbox_event", {
        name: `domain_outbox_event_${stamp(TOMORROW + 2 * DAY_MS)}`,
        from: new Date(TOMORROW + 2 * DAY_MS),
        to: new Date(TOMORROW + 3 * DAY_MS),
      }),
    ).toBe(false);
    expect(await notificationFamilyLegacyBound(prisma)).toBeNull();
  });
});
