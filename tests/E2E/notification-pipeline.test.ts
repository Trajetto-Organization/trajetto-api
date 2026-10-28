import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import { container } from "tsyringe";

import auth from "@/config/auth";

/**
 * The notification pipeline against a real Postgres.
 *
 * Its core — claim, lease, retry, the writes that settle a row — had no test
 * at all: what existed covered the pure rules around it. Every case here
 * drives the real service, one cycle at a time, with fake providers that
 * count what actually went out. "Sent twice" is the failure this file exists
 * to catch, so it is always asserted on the provider, not on a row.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const BUSINESS = "018fc000-0000-7000-8000-0000000004b1";
const RECIPIENT = "018fc000-0000-7000-8000-0000000004c1";
const MASTER = "018fc000-0000-7000-8000-0000000004c9";

let masterToken = "";

const mail = {
  sent: [] as Array<{ to: string; referenceId?: string }>,
  behaviour: async (): Promise<{ messageId?: string }> => ({
    messageId: "<m@x>",
  }),
};

const whatsapp = {
  sent: [] as Array<{ phoneNumber: string }>,
  behaviour: async (): Promise<Record<string, unknown>> => ({
    success: true,
    messageId: "wamid.1",
  }),
};

async function publish(topic = "account-payable.created"): Promise<string> {
  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `${topic}:${randomUUID()}`,
      topic,
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      actorId: RECIPIENT,
      payload: {
        accountPayableId: randomUUID(),
        businessId: BUSINESS,
        amount: 150,
        serviceOrderId: null,
        registrationUserId: RECIPIENT,
      },
    },
  });

  return event.id;
}

async function deliveriesOf(eventId: string) {
  return prisma.notificationDelivery.findMany({
    where: { outboxEventId: eventId },
    orderBy: { channel: "asc" },
  });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Pipeline",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `pipeline-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: RECIPIENT,
      name: "Pessoa Destinatária",
      email: `destinataria-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
      whatsapp_phone: "5511999990000",
      whatsapp_notifications_enabled: true,
    },
  });

  await prisma.user.create({
    data: {
      id: MASTER,
      name: "Pessoa Master",
      email: `master-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "MASTER",
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

  // After the app registered the real providers: the last registration wins.
  container.registerInstance("MailProvider", {
    sendMail: async (message: { to: string; referenceId?: string }) => {
      mail.sent.push(message);
      return mail.behaviour();
    },
  });

  container.registerInstance("WhatsAppProvider", {
    isConfigured: () => true,
    sendMessage: async (props: { phoneNumber: string }) => {
      whatsapp.sent.push(props);
      return whatsapp.behaviour();
    },
  });

  const pipelineModule = await import(
    "@/shared/notifications/notification-pipeline-service"
  );

  pipeline = pipelineModule.NotificationPipelineService.getInstance();
}, 120_000);

beforeEach(async () => {
  mail.sent = [];
  mail.behaviour = async () => ({ messageId: "<m@x>" });

  whatsapp.sent = [];
  whatsapp.behaviour = async () => ({ success: true, messageId: "wamid.1" });

  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.user.update({
    where: { id: RECIPIENT },
    data: { access_revoked: false },
  });

  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.notification.deleteMany({ where: { userId: RECIPIENT } });
  await prisma.activity.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.refreshToken.deleteMany({ where: { userId: MASTER } });
  await prisma.user.deleteMany({ where: { id: { in: [RECIPIENT, MASTER] } } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

async function drain(): Promise<void> {
  await pipeline.runOutboxCycle();
  await pipeline.runDeliveryCycle("internal");
  await pipeline.runDeliveryCycle("external");
}

describe("an event, end to end", () => {
  it("reaches every channel exactly once", async () => {
    const eventId = await publish();

    await drain();
    await drain(); // a second pass must find nothing left to send

    const rows = await deliveriesOf(eventId);

    expect(rows.map((row) => `${row.channel}:${row.status}`).sort()).toEqual([
      "ACTIVITY:DELIVERED",
      "EMAIL:DELIVERED",
      "IN_APP:DELIVERED",
      "WHATSAPP:DELIVERED",
    ]);

    expect(mail.sent).toHaveLength(1);
    expect(whatsapp.sent).toHaveLength(1);

    // The delivery id travels as the provider's idempotency key.
    const emailRow = rows.find((row) => row.channel === "EMAIL")!;
    expect(mail.sent[0].referenceId).toBe(emailRow.id);
  });
});

describe("a worker whose lease ran out", () => {
  it("cannot overwrite what the new owner decided", async () => {
    const eventId = await publish();
    await pipeline.runOutboxCycle();

    const [row] = await prisma.notificationDelivery.findMany({
      where: { outboxEventId: eventId, channel: "EMAIL" },
    });

    // Replica A claimed it (attempts 1) and stalled past its lease; replica B
    // reclaimed it (attempts 2), sent it and recorded DELIVERED.
    await prisma.notificationDelivery.update({
      where: { id: row.id },
      data: { status: "DELIVERED", attempts: 2, deliveredAt: new Date() },
    });

    const stale = {
      id: row.id,
      outboxEventId: eventId,
      userId: RECIPIENT,
      externalRecipientId: null,
      channel: "EMAIL",
      attempts: 1,
    };

    // A comes back and records its failure: this used to turn DELIVERED back
    // into PENDING, and the next claim sent a third copy.
    await (
      pipeline as never as {
        recordDeliveryFailure: (d: unknown, e: unknown) => Promise<void>;
      }
    ).recordDeliveryFailure(stale, new Error("timeout"));

    const after = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: row.id },
    });

    expect(after.status).toBe("DELIVERED");
    expect(after.attempts).toBe(2);
  });
});

describe("a send the provider accepted", () => {
  it("is not sent again when recording it fails for a moment", async () => {
    const eventId = await publish();
    await pipeline.runOutboxCycle();

    // The first DELIVERED write hits a database blip; the next one works.
    const service = pipeline as never as {
      settleDelivery: (
        delivery: unknown,
        data: { status?: string },
      ) => Promise<unknown>;
    };

    const original = service.settleDelivery.bind(pipeline);

    let failed = false;

    vi.spyOn(service, "settleDelivery").mockImplementation(
      (delivery: unknown, data: { status?: string }) => {
        if (!failed && data.status === "DELIVERED") {
          failed = true;
          return Promise.reject(new Error("connection reset"));
        }

        return original(delivery, data);
      },
    );

    await pipeline.runDeliveryCycle("external");

    vi.restoreAllMocks();

    // Before: the blip was read as a failed send, rescheduled in ~30s, and
    // the e-mail went out twice.
    const email = (await deliveriesOf(eventId)).find(
      (row) => row.channel === "EMAIL",
    )!;

    expect(email.status).toBe("DELIVERED");
    expect(mail.sent).toHaveLength(1);
  });
});

describe("an event this build does not know", () => {
  it("waits for a build that does, without spending an attempt", async () => {
    const eventId = await publish("topico.da.proxima.versao");

    await pipeline.runOutboxCycle();

    const event = await prisma.domainOutboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    });

    // Before: FAILED on the spot, for good — during every rolling deploy and
    // every rollback.
    expect(event.status).toBe("PENDING");
    expect(event.attempts).toBe(0);
    expect(event.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("gives up after a day, when it is no longer a deploy in progress", async () => {
    const eventId = await publish("topico.que.nunca.existiu");

    await prisma.domainOutboxEvent.update({
      where: { id: eventId },
      data: { created_at: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    await pipeline.runOutboxCycle();

    const event = await prisma.domainOutboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    });

    expect(event.status).toBe("FAILED");
  });
});

describe("a row whose process died on its last attempt", () => {
  it("is closed instead of claimed again", async () => {
    const eventId = await publish();
    await pipeline.runOutboxCycle();

    await prisma.notificationDelivery.updateMany({
      where: { outboxEventId: eventId, channel: "EMAIL" },
      data: {
        status: "PROCESSING",
        attempts: 7,
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    await pipeline.runDeliveryCycle("external");

    const email = (await deliveriesOf(eventId)).find(
      (row) => row.channel === "EMAIL",
    )!;

    expect(email.status).toBe("FAILED");
    expect(email.lastError).toMatch(/interrompido/);
    expect(mail.sent).toHaveLength(0);
  });
});

describe("the two lanes", () => {
  it(
    "delivers the bell while a backlog of e-mails waits",
    { timeout: 120_000 },
    async () => {
      // Fifty e-mails queued first, the in-app notification last. One FIFO
      // made the bell wait behind every one of them — and behind a provider
      // that hung, for the whole outage.
      for (let index = 0; index < 50; index += 1) await publish();
      await pipeline.runOutboxCycle();

      const newest = await publish();
      await pipeline.runOutboxCycle();

      await pipeline.runDeliveryCycle("internal");

      const bell = (await deliveriesOf(newest)).find(
        (row) => row.channel === "IN_APP",
      )!;

      expect(bell.status).toBe("DELIVERED");
      expect(mail.sent).toHaveLength(0);
    },
  );
});

describe("a provider that asks us to wait", () => {
  it("is not called again sooner than it asked", async () => {
    whatsapp.behaviour = async () => ({
      success: false,
      retryable: true,
      message: "(#130429) Rate limit hit",
      retryAfterSeconds: 600,
    });

    const eventId = await publish();
    await pipeline.runOutboxCycle();
    await pipeline.runDeliveryCycle("external");

    const row = (await deliveriesOf(eventId)).find(
      (candidate) => candidate.channel === "WHATSAPP",
    )!;

    expect(row.status).toBe("PENDING");

    // Our own backoff after one attempt is 30s; Meta asked for ten minutes.
    expect(row.availableAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
  });
});

describe("a recipient whose access was revoked", () => {
  it("gets nothing outside the product", async () => {
    await prisma.user.update({
      where: { id: RECIPIENT },
      data: { access_revoked: true },
    });

    const eventId = await publish();
    await drain();

    const rows = await deliveriesOf(eventId);
    const external = rows.filter((row) =>
      ["EMAIL", "WHATSAPP"].includes(row.channel),
    );

    expect(external.every((row) => row.status === "FAILED")).toBe(true);
    expect(mail.sent).toHaveLength(0);
    expect(whatsapp.sent).toHaveLength(0);
  });
});

describe("the dead letter", () => {
  it("sends a failed delivery again when a master replays it", async () => {
    mail.behaviour = async () => {
      throw new Error("provedor fora do ar");
    };

    const eventId = await publish();
    await pipeline.runOutboxCycle();

    const email = (await deliveriesOf(eventId)).find(
      (row) => row.channel === "EMAIL",
    )!;

    await prisma.notificationDelivery.update({
      where: { id: email.id },
      data: { status: "FAILED", attempts: 7, lastError: "provedor fora do ar" },
    });

    mail.behaviour = async () => ({ messageId: "<m@x>" });
    mail.sent = [];

    const response = await app.inject({
      method: "POST",
      url: "/health/dead-letter/replay",
      headers: { authorization: `Bearer ${masterToken}` },
      payload: { deliveryIds: [email.id] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ requeued: 1 });

    await pipeline.runDeliveryCycle("external");

    const after = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: email.id },
    });

    expect(after.status).toBe("DELIVERED");
    expect(mail.sent).toHaveLength(1);
  });

  it("does not send twice when the same replay is clicked twice", async () => {
    const eventId = await publish();
    await pipeline.runOutboxCycle();

    const email = (await deliveriesOf(eventId)).find(
      (row) => row.channel === "EMAIL",
    )!;

    await prisma.notificationDelivery.update({
      where: { id: email.id },
      data: { status: "FAILED" },
    });

    const replay = () =>
      app.inject({
        method: "POST",
        url: "/health/dead-letter/replay",
        headers: { authorization: `Bearer ${masterToken}` },
        payload: { deliveryIds: [email.id] },
      });

    expect((await replay()).json()).toEqual({ requeued: 1 });
    expect((await replay()).json()).toEqual({ requeued: 0 });
  });
});

/**
 * Outbox events in FAILED had a listing (GET /health/dead-letter/events) and
 * no way back but SQL on production: an event that ran out of expansions
 * during an outage longer than the retry schedule never notified anybody.
 */
describe("the dead letter of outbox events", () => {
  const replayEvents = (eventIds: string[], token = masterToken) =>
    app.inject({
      method: "POST",
      url: "/health/dead-letter/events/replay",
      headers: { authorization: `Bearer ${token}` },
      payload: { eventIds },
    });

  it("expands a failed event again when a master replays it", async () => {
    // The cycle under test is the one this test runs.
    const wake = vi.spyOn(pipeline, "wake").mockImplementation(() => undefined);

    const eventId = await publish();

    await prisma.domainOutboxEvent.update({
      where: { id: eventId },
      data: { status: "FAILED", attempts: 5, lastError: "banco fora do ar" },
    });

    const response = await replayEvents([eventId]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ requeued: 1 });
    expect(wake).toHaveBeenCalled();

    const requeued = await prisma.domainOutboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    });

    expect(requeued).toMatchObject({ status: "PENDING", attempts: 0 });
    // When, and which master — on the row only until the next expansion.
    expect(requeued.lastError).toContain("Reenfileirado manualmente");
    expect(requeued.lastError).toContain(MASTER);

    await pipeline.runOutboxCycle();

    // Published clears it: the durable trail is the route's warn log line,
    // as its OpenAPI description says.
    expect(
      await prisma.domainOutboxEvent.findUniqueOrThrow({
        where: { id: eventId },
      }),
    ).toMatchObject({ status: "PUBLISHED", attempts: 1, lastError: null });
    expect((await deliveriesOf(eventId)).length).toBeGreaterThan(0);
  });

  it("creates only the deliveries the event never created, and moves nothing twice", async () => {
    vi.spyOn(pipeline, "wake").mockImplementation(() => undefined);

    const eventId = await publish();
    await pipeline.runOutboxCycle();

    const before = (await deliveriesOf(eventId)).map((row) => row.id).sort();

    expect(before.length).toBeGreaterThan(0);

    // Failed after its deliveries were written (a crash before the
    // PUBLISHED mark, then the reclaim ceiling).
    await prisma.domainOutboxEvent.update({
      where: { id: eventId },
      data: { status: "FAILED", attempts: 5 },
    });

    expect((await replayEvents([eventId])).json()).toEqual({ requeued: 1 });

    await pipeline.runOutboxCycle();

    expect((await deliveriesOf(eventId)).map((row) => row.id).sort()).toEqual(
      before,
    );

    // PUBLISHED now: a second click finds nothing to move.
    expect((await replayEvents([eventId])).json()).toEqual({ requeued: 0 });
  });

  it("is refused to a company administrator, and the event stays where it was", async () => {
    const familyId = randomUUID();

    await prisma.refreshToken.create({
      data: {
        userId: RECIPIENT,
        token_hash: randomUUID(),
        jti: randomUUID(),
        family_id: familyId,
        expires_in: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const adminToken = sign(
      {
        tokenType: "access",
        role: "BUSINESS_ADMIN",
        businessId: BUSINESS,
        driverId: null,
        sessionVersion: 0,
        familyId,
      },
      auth.secret_token,
      { subject: RECIPIENT, expiresIn: "1h" },
    );

    const eventId = await publish();

    await prisma.domainOutboxEvent.update({
      where: { id: eventId },
      data: { status: "FAILED", attempts: 5 },
    });

    try {
      const response = await replayEvents([eventId], adminToken);

      expect(response.statusCode).toBe(403);
      expect(
        await prisma.domainOutboxEvent.findUniqueOrThrow({
          where: { id: eventId },
        }),
      ).toMatchObject({ status: "FAILED", attempts: 5 });
    } finally {
      await prisma.refreshToken.deleteMany({ where: { userId: RECIPIENT } });
    }
  });

  it("refuses a body without events", async () => {
    expect((await replayEvents([])).statusCode).toBe(400);
  });

  /**
   * Another MASTER of its own for each run. The limiter counts per route
   * and per user in Redis, which outlives the run: under the fixed MASTER
   * these calls would add to the cases above, and a rerun within the
   * minute would start from a spent bucket.
   */
  async function withFreshMaster(
    use: (token: string) => Promise<void>,
  ): Promise<void> {
    const id = randomUUID();
    const familyId = randomUUID();

    await prisma.user.create({
      data: {
        id,
        name: "Outra Pessoa Master",
        email: `master-${id}@exemplo.com.br`,
        password: "nao-usado",
        role: "MASTER",
      },
    });
    await prisma.refreshToken.create({
      data: {
        userId: id,
        token_hash: randomUUID(),
        jti: randomUUID(),
        family_id: familyId,
        expires_in: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    try {
      await use(
        sign(
          {
            tokenType: "access",
            role: "MASTER",
            businessId: null,
            driverId: null,
            sessionVersion: 0,
            familyId,
          },
          auth.secret_token,
          { subject: id, expiresIn: "1h" },
        ),
      );
    } finally {
      await prisma.refreshToken.deleteMany({ where: { userId: id } });
      await prisma.user.deleteMany({ where: { id } });
    }
  }

  it("refuses more than 100 events at once, and moves none of them", async () => {
    vi.spyOn(pipeline, "wake").mockImplementation(() => undefined);

    const eventId = await publish();

    await prisma.domainOutboxEvent.update({
      where: { id: eventId },
      data: { status: "FAILED", attempts: 5 },
    });

    const tooMany = [
      eventId,
      ...Array.from({ length: 100 }, () => randomUUID()),
    ];

    await withFreshMaster(async (token) => {
      expect((await replayEvents(tooMany, token)).statusCode).toBe(400);
      expect((await replayEvents(tooMany.slice(0, 100), token)).json()).toEqual(
        { requeued: 1 },
      );
    });
  });

  it("allows a master 10 replays a minute", async () => {
    await withFreshMaster(async (token) => {
      // Counted before the body is read: refused bodies spend it too, and
      // nothing is written meanwhile.
      for (let call = 0; call < 10; call += 1) {
        expect((await replayEvents([], token)).statusCode).toBe(400);
      }

      expect((await replayEvents([], token)).statusCode).toBe(429);
    });
  });
});

describe("a tower request decided while its messages wait (decision 6.3)", () => {
  // Red before: the "still waiting" check ran only when the notice fanned
  // out. Once the rows existed, an e-mail or WhatsApp still in the queue (or
  // in retry) rang an operator about a request somebody had already decided.
  it("stops the messages outside the product, and keeps the bell", async () => {
    // The order under test is "fanned out, decided, THEN delivered": hold
    // every wake (the dead-letter replay above schedules one) and let a cycle
    // already in flight finish, so only this test claims the rows.
    vi.spyOn(pipeline, "wake").mockImplementation(() => undefined);

    await vi.waitFor(
      () =>
        expect((pipeline as unknown as { isBusy(): boolean }).isBusy()).toBe(
          false,
        ),
      { timeout: 15_000, interval: 50 },
    );

    let waiting = true;

    container.registerInstance("OccurrenceAuthorizationRepository", {
      isWaiting: async () => waiting,
    });

    const occurrenceId = randomUUID();

    const event = await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `delivery-occurrence.authorization_requested:${occurrenceId}`,
        topic: "delivery-occurrence.authorization_requested",
        aggregateType: "delivery",
        aggregateId: randomUUID(),
        businessId: BUSINESS,
        actorId: RECIPIENT,
        payload: {
          occurrenceId,
          deliveryId: randomUUID(),
          businessId: BUSINESS,
          recipientName: "Mercado Central",
          occurrenceTypeName: "Cliente ausente",
          blocksDelivery: true,
          description: null,
          reporterName: "João Motorista",
          fromDriver: true,
          photosCount: 0,
          answers: [],
          requestedAt: new Date().toISOString(),
        },
      },
    });

    // Fanned out while the request waits: the operator gets every channel.
    await pipeline.runOutboxCycle();

    const channels = (await deliveriesOf(event.id)).map((row) => row.channel);

    expect(channels).toEqual(
      expect.arrayContaining(["IN_APP", "EMAIL", "WHATSAPP"]),
    );

    // Decided before the worker reached the rows.
    waiting = false;

    await pipeline.runDeliveryCycle("internal");
    await pipeline.runDeliveryCycle("external");

    const rows = await deliveriesOf(event.id);
    const byChannel = new Map(rows.map((row) => [row.channel, row]));

    // Asserted on the providers, filtered to this event: a cycle the test
    // before scheduled may still finish its own send in the background.
    const ours = new Set(rows.map((row) => row.id));

    expect(
      mail.sent.filter((message) => ours.has(message.referenceId ?? "")),
    ).toEqual([]);
    expect(
      whatsapp.sent.filter((message) =>
        JSON.stringify(message).includes("Cliente ausente"),
      ),
    ).toEqual([]);

    for (const channel of ["EMAIL", "WHATSAPP"] as const) {
      expect(byChannel.get(channel), channel).toMatchObject({
        status: "FAILED",
      });
      expect(byChannel.get(channel)?.lastError, channel).toContain(
        "Pedido de autorização já resolvido",
      );
    }

    // The inbox row is the record of what was asked: it stays.
    expect(byChannel.get("IN_APP")?.status).toBe("DELIVERED");
  });
});
