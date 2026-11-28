import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { v7 as uuidV7 } from "uuid";

import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";
import { OutboxService } from "@/shared/notifications/outbox-service";
import { unpartitionQueues } from "./support/queue-partitions";

/**
 * The outbox's keys in a table of their own (plano-escala F5-02).
 *
 * Three promises rest on an event's key today, all through the global
 * unique on domain_outbox_event."eventKey": a caller's key written twice is
 * a P2002 (the AI alert's crash-replay counts on it), publishOnce writes
 * once per key, and two transactions publishing one customer group (B6,
 * the 90-second window) land on one row with both entries. The queues are
 * partitioned by day later in the plan, and that unique cannot stay; so
 * each promise has to hold through outbox_event_key alone.
 *
 * This file proves them twice: with the legacy unique as a serving
 * database still has it until the contraction of wave 10 runs (F5-06;
 * built here, since the E2E template starts contracted), and after
 * dropping it, as that contraction does. In between, what the rolling
 * deploy leaves: an event the previous image wrote under a key without the
 * key's row is adopted, never doubled. And the nightly purge takes each
 * key with its event.
 */
const prisma = createPrismaClient();
const otherConnection = createPrismaClient();
const outbox = new OutboxService();

const BUSINESS = "019a8f40-0000-7000-8000-00000000000a";
const DAY_MS = 24 * 60 * 60 * 1000;

// Any topic: the pipeline never runs here (workers off below).
const event = (eventKey?: string) => ({
  topic: "account-payable.created" as const,
  aggregateType: "delivery",
  aggregateId: randomUUID(),
  businessId: BUSINESS,
  payload: { deliveryId: randomUUID() } as never,
  ...(eventKey && { eventKey }),
});

/** Publishes into a group, in a transaction of its own, held for a minute. */
const merge = (
  client: typeof prisma,
  mergeKey: string,
  deliveryId: string,
  whenTaken: "separate" | "skip" = "separate",
) =>
  client.$transaction((tx) =>
    outbox.publishMerged(
      tx,
      {
        topic: "account-payable.created",
        aggregateType: "delivery",
        aggregateId: deliveryId,
        businessId: BUSINESS,
        payload: { deliveries: [{ deliveryId }] } as never,
      },
      {
        mergeKey,
        mergeField: "deliveries",
        mergeIdentity: "deliveryId",
        delayMs: 60_000,
        whenTaken,
      },
    ),
  );

const eventsUnder = (eventKey: string) =>
  prisma.domainOutboxEvent.findMany({ where: { eventKey } });

const keyOf = (eventKey: string) =>
  prisma.outboxEventKey.findUnique({ where: { event_key: eventKey } });

function p2002(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

const workersWere = env.WORKERS_ENABLED;

beforeAll(async () => {
  // A publish wakes the pipeline; here the rows must stay as written, so
  // nothing is claimed or published behind the assertions.
  env.WORKERS_ENABLED = false;

  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora das Chaves",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "55666111000191",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `chaves-${randomUUID()}@exemplo.com.br`,
    },
  });
}, 60_000);

afterAll(async () => {
  env.WORKERS_ENABLED = workersWere;
  await prisma.$disconnect();
  await otherConnection.$disconnect();
}, 60_000);

function promises(label: string): void {
  describe(`the outbox's keys, ${label}`, () => {
    it("write a caller's key with its event, and refuse it a second time with P2002", async () => {
      const key = `keyed:${randomUUID()}`;

      await prisma.$transaction((tx) => outbox.publish(tx, event(key)));

      const [written] = await eventsUnder(key);
      expect(await keyOf(key)).toMatchObject({ event_id: written.id });

      const again = await prisma
        .$transaction((tx) => outbox.publish(tx, event(key)))
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(p2002(again), String(again)).toBe(true);
      expect(await eventsUnder(key)).toHaveLength(1);
    });

    it("give no row to an event without a key of its own", async () => {
      const aggregateId = randomUUID();

      await prisma.$transaction((tx) =>
        outbox.publish(tx, { ...event(), aggregateId }),
      );

      const [written] = await prisma.domainOutboxEvent.findMany({
        where: { aggregateId },
      });

      expect(written).toBeDefined();
      expect(await keyOf(written.eventKey)).toBeNull();
    });

    it("let publishOnce write once per key, however many calls race", async () => {
      const key = `once:${randomUUID()}`;

      const answers = await Promise.all(
        Array.from({ length: 5 }, () =>
          outbox.publishOnce({ ...event(key), eventKey: key }),
        ),
      );

      expect(answers.filter(Boolean)).toHaveLength(1);
      expect(await eventsUnder(key)).toHaveLength(1);
      expect((await keyOf(key))?.event_id).toBe((await eventsUnder(key))[0].id);
    });

    it("merge two transactions publishing one group at once into one row", async () => {
      const group = `group:${randomUUID()}`;
      const first = randomUUID();
      const second = randomUUID();

      await Promise.all([
        merge(prisma, group, first),
        merge(otherConnection, group, second),
      ]);

      const rows = await eventsUnder(group);

      expect(rows).toHaveLength(1);
      expect(
        (
          rows[0].payload as { deliveries: Array<{ deliveryId: string }> }
        ).deliveries
          .map((entry) => entry.deliveryId)
          .sort(),
      ).toEqual([first, second].sort());
      expect((await keyOf(group))?.event_id).toBe(rows[0].id);
    });

    it("send a publish on its own, or drop it, once the group's row was taken", async () => {
      const group = `group:${randomUUID()}`;

      await merge(prisma, group, randomUUID());
      await prisma.domainOutboxEvent.updateMany({
        where: { eventKey: group },
        data: { status: "PROCESSING" },
      });

      expect(await merge(prisma, group, randomUUID(), "skip")).toBe(false);

      const late = randomUUID();
      expect(await merge(prisma, group, late, "separate")).toBe(true);

      const separate = await prisma.domainOutboxEvent.findMany({
        where: { aggregateId: late },
      });

      expect(separate).toHaveLength(1);
      expect(separate[0].eventKey).not.toBe(group);
      expect(await eventsUnder(group)).toHaveLength(1);
    });
  });
}

// A serving database until the contraction's step runs: the template is
// a new database, which the migration already contracted, and whose queues
// the swap of F5-09 partitioned (a partitioned table cannot hold this
// unique): the outbox goes back to the plain table production still has.
beforeAll(async () => {
  await unpartitionQueues(["domain_outbox_event"]);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "domain_outbox_event_eventKey_key" ON "domain_outbox_event"("eventKey")`,
  );
});

promises("with the legacy unique on eventKey");

describe("an event the previous image wrote under a key, without its key row", () => {
  // The rolling deploy: the image before this one still publishes, and
  // knows nothing of outbox_event_key.
  const legacyEvent = async (eventKey: string, payload: object) =>
    prisma.domainOutboxEvent.create({
      data: {
        id: uuidV7(),
        eventKey,
        topic: "account-payable.created",
        aggregateType: "delivery",
        aggregateId: randomUUID(),
        businessId: BUSINESS,
        payload,
        availableAt: new Date(Date.now() + 60_000),
      },
    });

  it("is adopted by publishOnce, which writes nothing more", async () => {
    const key = `once:${randomUUID()}`;
    const legacy = await legacyEvent(key, { deliveryId: randomUUID() });

    expect(await outbox.publishOnce({ ...event(key), eventKey: key })).toBe(
      false,
    );
    expect(await eventsUnder(key)).toHaveLength(1);
    expect((await keyOf(key))?.event_id).toBe(legacy.id);
  });

  it("is the group's row a later publish merges into", async () => {
    const group = `group:${randomUUID()}`;
    const earlier = randomUUID();
    const legacy = await legacyEvent(group, {
      deliveries: [{ deliveryId: earlier }],
    });

    const later = randomUUID();
    await merge(prisma, group, later);

    const rows = await eventsUnder(group);

    expect(rows.map((row) => row.id)).toEqual([legacy.id]);
    expect(
      (
        rows[0].payload as { deliveries: Array<{ deliveryId: string }> }
      ).deliveries.map((entry) => entry.deliveryId),
    ).toEqual([earlier, later]);
    expect((await keyOf(group))?.event_id).toBe(legacy.id);
  });
});

describe("the nightly purge", () => {
  it("takes each key with its event, and leaves the keys of the events it keeps", async () => {
    const { cleanupNotificationPipelineJob } =
      await import("@/jobs/cron/cleanup-notification-pipeline-job");

    const old = new Date(Date.now() - 100 * DAY_MS);
    const published = `purge:${randomUUID()}`;
    const failed = `purge:${randomUUID()}`;
    const kept = `purge:${randomUUID()}`;

    for (const key of [published, failed, kept]) {
      await prisma.$transaction((tx) => outbox.publish(tx, event(key)));
    }

    await prisma.domainOutboxEvent.updateMany({
      where: { eventKey: published },
      data: { status: "PUBLISHED", processedAt: old },
    });
    await prisma.$executeRaw`
      UPDATE "domain_outbox_event" SET "status" = 'FAILED', "updated_at" = ${old}
      WHERE "eventKey" = ${failed}
    `;
    // The FAILED event's key as old as its event.
    await prisma.outboxEventKey.update({
      where: { event_key: failed },
      data: { created_at: old },
    });
    await prisma.domainOutboxEvent.updateMany({
      where: { eventKey: kept },
      data: { status: "PUBLISHED", processedAt: new Date() },
    });

    await cleanupNotificationPipelineJob.handler();

    expect(await keyOf(published)).toBeNull();
    expect(await keyOf(failed)).toBeNull();
    expect(await keyOf(kept)).not.toBeNull();
    expect(await eventsUnder(kept)).toHaveLength(1);
  }, 60_000);
});

describe("without the legacy unique", () => {
  beforeAll(async () => {
    // What the contraction of wave 10 (F5-06) leaves.
    await prisma.$executeRawUnsafe(
      `DROP INDEX IF EXISTS "domain_outbox_event_eventKey_key"`,
    );
  });

  promises("with outbox_event_key alone");
});
