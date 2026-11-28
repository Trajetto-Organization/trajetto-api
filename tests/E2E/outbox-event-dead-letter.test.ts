import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";
import { uuid7Instant } from "@/shared/time/uuid7-floor";

/**
 * The dead letter of outbox events (plano-escala F5-10).
 *
 * A FAILED event used to stay 90 days in domain_outbox_event. The queues
 * become partitioned by day and a day is dropped whole at 30 (F5-09,
 * F5-11), so the nightly purge now moves a FAILED event to
 * outbox_event_dead_letter at 30 days — copy and delete in one statement —
 * and keeps the copy OUTBOX_FAILED_RETENTION_DAYS (90) from the failure.
 * For the operator nothing is lost: the listing joins both places, and a
 * copy is replayed as a new event for the whole 90 days.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const BUSINESS = "019a9a80-0000-7000-8000-000000000c01";
const RECIPIENT = "019a9a80-0000-7000-8000-000000000c02";
const MASTER = "019a9a80-0000-7000-8000-000000000c03";

const DAY_MS = 24 * 60 * 60 * 1000;

let masterToken = "";

/** A FAILED event that gave up `daysAgo` days ago. */
async function failedEvent(daysAgo: number): Promise<string> {
  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `dead-letter:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      actorId: MASTER,
      status: "FAILED",
      attempts: 10,
      lastError: "Expansão falhou: banco fora do ar",
      correlationId: randomUUID(),
      payload: {
        accountPayableId: randomUUID(),
        businessId: BUSINESS,
        amount: 150,
        serviceOrderId: null,
        registrationUserId: RECIPIENT,
      },
    },
  });

  await prisma.$executeRaw`
    UPDATE "domain_outbox_event"
    SET "updated_at" = ${new Date(Date.now() - daysAgo * DAY_MS)}
    WHERE "id" = ${event.id}
  `;

  return event.id;
}

async function runPurge(): Promise<void> {
  const { cleanupNotificationPipelineJob } =
    await import("@/jobs/cron/cleanup-notification-pipeline-job");

  await cleanupNotificationPipelineJob.handler({
    scheduledFor: new Date(),
  } as never);
}

const listEvents = () =>
  app.inject({
    method: "GET",
    url: "/health/dead-letter/events?pageSize=100",
    headers: { authorization: `Bearer ${masterToken}` },
  });

const replayEvents = (eventIds: string[]) =>
  app.inject({
    method: "POST",
    url: "/health/dead-letter/events/replay",
    headers: { authorization: `Bearer ${masterToken}` },
    payload: { eventIds },
  });

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Dead Letter",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "88999000000127",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `dead-letter-${randomUUID()}@example.com`,
    },
  });

  await prisma.user.createMany({
    data: [
      {
        id: RECIPIENT,
        name: "Pessoa Responsável",
        email: `dead-letter-${randomUUID()}@example.com`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: BUSINESS,
      },
      {
        id: MASTER,
        name: "Pessoa Master",
        email: `dead-letter-${randomUUID()}@example.com`,
        password: "nao-usado",
        role: "MASTER",
      },
    ],
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

  masterToken = sign(
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

  pipeline = (
    await import("@/shared/notifications/notification-pipeline-service")
  ).NotificationPipelineService.getInstance();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the dead letter of outbox events", () => {
  it("moves a FAILED event out of the queue at 30 days, with everything a replay needs", async () => {
    const old = await failedEvent(31);
    const recent = await failedEvent(2);

    const original = await prisma.domainOutboxEvent.findUniqueOrThrow({
      where: { id: old },
    });

    await runPurge();

    expect(await prisma.domainOutboxEvent.count({ where: { id: old } })).toBe(
      0,
    );
    expect(
      await prisma.domainOutboxEvent.count({ where: { id: recent } }),
    ).toBe(1);

    const copy = await prisma.outboxEventDeadLetter.findUniqueOrThrow({
      where: { id: old },
    });

    expect(copy).toMatchObject({
      eventKey: original.eventKey,
      topic: original.topic,
      aggregateType: original.aggregateType,
      aggregateId: original.aggregateId,
      businessId: original.businessId,
      actorId: original.actorId,
      payload: original.payload,
      attempts: original.attempts,
      lastError: original.lastError,
      correlationId: original.correlationId,
      created_at: original.created_at,
      failedAt: original.updated_at,
      replayed_at: null,
    });
  });

  it("lists the FAILED events of both places, newest failure first", async () => {
    const archived = await failedEvent(40);
    const live = await failedEvent(1);

    await runPurge();

    const response = await listEvents();

    expect(response.statusCode).toBe(200);

    const body = response.json();
    const ids = body.data.map((row: { id: string }) => row.id);

    expect(ids.indexOf(live)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(archived)).toBeGreaterThan(ids.indexOf(live));

    expect(
      body.data.find((row: { id: string }) => row.id === live),
    ).toMatchObject({ archived: false, attempts: 10 });
    expect(
      body.data.find((row: { id: string }) => row.id === archived),
    ).toMatchObject({
      archived: true,
      topic: "account-payable.created",
      businessId: BUSINESS,
      lastError: "Expansão falhou: banco fora do ar",
    });

    const [{ live: liveCount, copies }] = await prisma.$queryRaw<
      Array<{ live: number; copies: number }>
    >`
      SELECT
        (SELECT count(*) FROM "domain_outbox_event"
         WHERE "status" = 'FAILED')::int AS live,
        (SELECT count(*) FROM "outbox_event_dead_letter"
         WHERE "replayed_at" IS NULL)::int AS copies
    `;

    expect(body.total).toBe(liveCount + copies);
  });

  it("replays a copy as a new event, once, which the pipeline expands", async () => {
    vi.spyOn(pipeline, "wake").mockImplementation(() => undefined);

    const archived = await failedEvent(45);

    await runPurge();

    const first = await replayEvents([archived]);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ requeued: 1 });

    // A double click: the copy was already replayed.
    expect((await replayEvents([archived])).json()).toEqual({ requeued: 0 });

    const copy = await prisma.outboxEventDeadLetter.findUniqueOrThrow({
      where: { id: archived },
    });

    expect(copy.replayed_at).not.toBeNull();
    expect(copy.replayed_event_id).not.toBeNull();

    const recreated = await prisma.domainOutboxEvent.findUniqueOrThrow({
      where: { id: copy.replayed_event_id! },
    });

    expect(recreated).toMatchObject({
      status: "PENDING",
      attempts: 0,
      topic: copy.topic,
      aggregateType: copy.aggregateType,
      aggregateId: copy.aggregateId,
      businessId: copy.businessId,
      actorId: copy.actorId,
      payload: copy.payload,
      correlationId: copy.correlationId,
    });
    expect(recreated.eventKey).not.toBe(copy.eventKey);
    expect(recreated.lastError).toContain(archived);
    // A uuid v7 of now: the queue's ids stay time keys.
    expect(Math.abs(uuid7Instant(recreated.id)! - Date.now())).toBeLessThan(
      60_000,
    );

    // Gone from the listing: there is nothing left to do about it.
    expect(
      (await listEvents())
        .json()
        .data.some((row: { id: string }) => row.id === archived),
    ).toBe(false);

    await pipeline.runOutboxCycle();

    expect(
      (
        await prisma.domainOutboxEvent.findUniqueOrThrow({
          where: { id: recreated.id },
        })
      ).status,
    ).toBe("PUBLISHED");
    expect(
      await prisma.notificationDelivery.count({
        where: { outboxEventId: recreated.id },
      }),
    ).toBeGreaterThan(0);
  });

  // A replica that lost an event's lease can still expand it, the
  // deliveries go out, and the event then fails under the new owner. The
  // move deletes those deliveries with the event. A copy replayed as a new
  // event (new id, so new delivery ids) used to expand every recipient
  // again: whoever had the WhatsApp, the e-mail or the bell got it twice.
  // A live replay creates only the deliveries the event never had; so must
  // a copy's.
  /**
   * An event expanded for `registrationUserId`, whose deliveries all went
   * out, and which then failed 45 days ago: moved by the purge.
   */
  async function expandedThenFailed(registrationUserId: string) {
    const event = await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `dead-letter:${randomUUID()}`,
        topic: "account-payable.created",
        aggregateType: "account-payable",
        aggregateId: randomUUID(),
        businessId: BUSINESS,
        actorId: MASTER,
        correlationId: randomUUID(),
        payload: {
          accountPayableId: randomUUID(),
          businessId: BUSINESS,
          amount: 150,
          serviceOrderId: null,
          registrationUserId,
        },
      },
    });

    await pipeline.runOutboxCycle();

    const original = await prisma.notificationDelivery.findMany({
      where: { outboxEventId: event.id },
    });

    expect(original.length).toBeGreaterThan(0);

    // They went out; then the event failed under the replica that took it
    // over, 45 days ago.
    const deliveredAt = new Date(Date.now() - 45 * DAY_MS);

    await prisma.notificationDelivery.updateMany({
      where: { outboxEventId: event.id },
      data: {
        status: "DELIVERED",
        attempts: 1,
        deliveredAt,
        providerMessageId: "mensagem-original",
      },
    });
    await prisma.$executeRaw`
      UPDATE "domain_outbox_event"
      SET "status" = 'FAILED', "attempts" = 10, "processedAt" = NULL,
          "lastError" = 'Falhou depois de expandir',
          "updated_at" = ${deliveredAt}
      WHERE "id" = ${event.id}
    `;

    await runPurge();

    return { event, original, deliveredAt };
  }

  it("replays a copy without sending again what the original already delivered", async () => {
    vi.spyOn(pipeline, "wake").mockImplementation(() => undefined);

    const { event, original, deliveredAt } =
      await expandedThenFailed(RECIPIENT);

    expect(
      await prisma.notificationDelivery.count({
        where: { outboxEventId: event.id },
      }),
    ).toBe(0);

    expect((await replayEvents([event.id])).json()).toEqual({ requeued: 1 });

    const copy = await prisma.outboxEventDeadLetter.findUniqueOrThrow({
      where: { id: event.id },
    });

    await pipeline.runOutboxCycle();

    expect(
      (
        await prisma.domainOutboxEvent.findUniqueOrThrow({
          where: { id: copy.replayed_event_id! },
        })
      ).status,
    ).toBe("PUBLISHED");

    const replayed = await prisma.notificationDelivery.findMany({
      where: { outboxEventId: copy.replayed_event_id! },
    });
    const recipient = (row: {
      userId: string | null;
      externalRecipientId: string | null;
      channel: string;
    }) => `${row.userId ?? ""}|${row.externalRecipientId ?? ""}|${row.channel}`;

    expect(replayed.map(recipient).sort()).toEqual(
      original.map(recipient).sort(),
    );

    // Nothing left to send: every one is the delivery that already went.
    for (const row of replayed) {
      expect(row).toMatchObject({
        status: "DELIVERED",
        attempts: 1,
        deliveredAt,
        providerMessageId: "mensagem-original",
        business_id: BUSINESS,
      });
    }
  });

  // The recipient left between the move and the replay: there is no row to
  // give back to them (the foreign key would refuse it, and the expansion
  // no longer reaches them), and the replay must not fail for it.
  it("replays a copy whose recipient was deleted since, leaving that delivery out", async () => {
    vi.spyOn(pipeline, "wake").mockImplementation(() => undefined);

    const leaving = await prisma.user.create({
      data: {
        name: "Pessoa que saiu",
        email: `dead-letter-${randomUUID()}@example.com`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: BUSINESS,
      },
    });

    const { event, original } = await expandedThenFailed(leaving.id);

    expect(original.some((row) => row.userId === leaving.id)).toBe(true);

    await prisma.user.delete({ where: { id: leaving.id } });

    const response = await replayEvents([event.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ requeued: 1 });

    const copy = await prisma.outboxEventDeadLetter.findUniqueOrThrow({
      where: { id: event.id },
    });
    const restored = await prisma.notificationDelivery.findMany({
      where: { outboxEventId: copy.replayed_event_id! },
    });

    expect(restored.some((row) => row.userId === leaving.id)).toBe(false);
    // The others the original reached are back, already delivered.
    expect(restored.map((row) => row.userId).sort()).toEqual(
      original
        .filter((row) => row.userId !== leaving.id)
        .map((row) => row.userId)
        .sort(),
    );
    expect(restored.every((row) => row.status === "DELIVERED")).toBe(true);
  });

  it("requeues a live FAILED event in place, and a copy, in one request", async () => {
    vi.spyOn(pipeline, "wake").mockImplementation(() => undefined);

    const archived = await failedEvent(50);

    await runPurge();

    const live = await failedEvent(3);

    expect((await replayEvents([live, archived, randomUUID()])).json()).toEqual(
      { requeued: 2 },
    );

    expect(
      await prisma.domainOutboxEvent.findUniqueOrThrow({ where: { id: live } }),
    ).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  it("keeps a copy until OUTBOX_FAILED_RETENTION_DAYS after the failure", async () => {
    const saved = env.OUTBOX_FAILED_RETENTION_DAYS;

    const young = await failedEvent(60);
    const expired = await failedEvent(95);

    try {
      await runPurge();

      // Moved at 30 days, the 95-day-old one expired at once.
      expect(
        await prisma.outboxEventDeadLetter.count({ where: { id: young } }),
      ).toBe(1);
      expect(
        await prisma.outboxEventDeadLetter.count({ where: { id: expired } }),
      ).toBe(0);

      env.OUTBOX_FAILED_RETENTION_DAYS = 59;

      await runPurge();

      expect(
        await prisma.outboxEventDeadLetter.count({ where: { id: young } }),
      ).toBe(0);
    } finally {
      env.OUTBOX_FAILED_RETENTION_DAYS = saved;
    }
  });
});
