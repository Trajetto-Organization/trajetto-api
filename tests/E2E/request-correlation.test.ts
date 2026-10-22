import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import pino from "pino";
import { sign } from "jsonwebtoken";
import { container } from "tsyringe";

import auth from "@/config/auth";
import { generateApiKey } from "@/shared/integration/api-key-rules";

/**
 * One id from the request to the message that left because of it (OBS-06).
 *
 * The request id was Fastify's per-process counter, `req-1`, `req-2`… — the
 * same ids on both replicas and after every restart, never sent back to the
 * caller. Nothing carried it into the outbox, the pipeline logged failures as
 * free text with no topic or tenant, and a delivery that succeeded wrote no
 * line at all. "The driver never got the fine notice at 10:03" became SQL by
 * aggregate id and time window, and after the 30-day purge, no answer.
 *
 * Now: a uuid v7 per request (or the caller's own, when well-formed), echoed
 * in `x-request-id` and in the 500 body; the authenticated request's lines
 * name the user and the tenant; the outbox row keeps the id as
 * `correlationId`; and the pipeline writes one structured line per delivery
 * outcome carrying it.
 */
const prisma = new PrismaClient();

const BUSINESS = "018fc000-0000-7000-8000-0000000006b1";
const USER = "018fc000-0000-7000-8000-0000000006c1";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

let token = "";
let apiKeyToken = "";
let apiKeyId = "";
let written = "";

const mail = {
  behaviour: async (): Promise<{ messageId?: string }> => ({
    messageId: "<m@x>",
  }),
};

const lines = () =>
  written
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const capture = {
  write(chunk: string) {
    written += chunk;
  },
};

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora Rastreável",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "33444555000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `correlacao-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Gestora Rastreável",
      email: `gestora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId: USER,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  token = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: USER, expiresIn: "1h" },
  );

  await prisma.businessEntitlement.create({
    data: { businessId: BUSINESS, module: "DELIVERIES", enabled: true },
  });

  const machineKey = generateApiKey();

  apiKeyId = (
    await prisma.apiKey.create({
      data: {
        name: "Integração rastreável",
        prefix: machineKey.prefix,
        token_hash: machineKey.tokenHash,
        scopes: ["deliveries:read"],
        businessId: BUSINESS,
      },
    })
  ).id;

  apiKeyToken = machineKey.token;

  ({ app } = await import("@/http"));

  const { ensureAuthenticated } = await import(
    "@/modules/middlewares/ensure-authenticated"
  );
  const { ensureApiKey } = await import("@/modules/middlewares/ensure-api-key");
  const { OutboxService } = await import(
    "@/shared/notifications/outbox-service"
  );
  const database = (await import("@/../infra/database")).default;

  // Test-only routes on the real app, before it boots: the root hooks and the
  // error handler apply to them exactly as to any route.
  app.get(
    "/__test__/whoami",
    { onRequest: [ensureAuthenticated] },
    async () => ({ ok: true }),
  );

  app.get("/__test__/machine", { onRequest: [ensureApiKey] }, async () => ({
    ok: true,
  }));

  app.post(
    "/__test__/publish",
    { onRequest: [ensureAuthenticated] },
    async () => {
      await database.$transaction((tx) =>
        new OutboxService().publish(tx, {
          topic: "account-payable.created",
          aggregateType: "account-payable",
          aggregateId: randomUUID(),
          businessId: BUSINESS,
          actorId: USER,
          payload: {
            accountPayableId: randomUUID(),
            businessId: BUSINESS,
            amount: 150,
            serviceOrderId: null,
            registrationUserId: USER,
          },
        }),
      );

      return { ok: true };
    },
  );

  app.get("/__test__/boom", async () => {
    throw new Error("falha interna simulada");
  });

  await app.ready();

  // After the app registered the real providers: the last registration wins.
  container.registerInstance("MailProvider", {
    sendMail: async () => mail.behaviour(),
  });

  container.registerInstance("WhatsAppProvider", {
    isConfigured: () => true,
    sendMessage: async () => ({ success: true, messageId: "wamid.1" }),
  });

  // Every line the application writes lands here. The shared logger, when
  // there is one, is the root of the request loggers and of the workers'.
  const sharedLogger = await import("@/shared/logging/logger")
    .then((module) => module.logger as unknown as Record<symbol, unknown>)
    .catch(() => null);

  if (sharedLogger) sharedLogger[pino.symbols.streamSym] = capture;

  (app.log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] =
    capture;

  pipeline = (
    await import("@/shared/notifications/notification-pipeline-service")
  ).NotificationPipelineService.getInstance();
}, 120_000);

beforeEach(async () => {
  written = "";
  mail.behaviour = async () => ({ messageId: "<m@x>" });

  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
});

afterAll(async () => {
  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.notification.deleteMany({ where: { userId: USER } });
  await prisma.activity.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.refreshToken.deleteMany({ where: { userId: USER } });
  await prisma.apiKey.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.businessEntitlement.deleteMany({
    where: { businessId: BUSINESS },
  });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

/** The pipeline also wakes on its own after a publish; this just insists. */
async function drainUntil(done: () => Promise<boolean> | boolean) {
  for (let round = 0; round < 40; round += 1) {
    await pipeline.runOutboxCycle();
    await pipeline.runDeliveryCycle("internal");
    await pipeline.runDeliveryCycle("external");

    if (await done()) return;

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("the pipeline never settled");
}

describe("the request id", () => {
  it("is a uuid v7, different on every request, and sent back", async () => {
    const first = await app.inject({ method: "GET", url: "/health/liveness" });
    const second = await app.inject({ method: "GET", url: "/health/liveness" });

    const ids = [first.headers["x-request-id"], second.headers["x-request-id"]];

    expect(ids[0]).toMatch(UUID_V7);
    expect(ids[1]).toMatch(UUID_V7);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("is the one on the request's own log lines", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/liveness",
    });
    const id = response.headers["x-request-id"];

    const reqIds = lines()
      .filter((line) => line.msg === "request completed")
      .map((line) => line.reqId);

    expect(reqIds).toContain(id);
  });

  it("keeps a well-formed id the caller sent", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/liveness",
      headers: { "x-request-id": "web-7f3c2a10-abcd" },
    });

    expect(response.headers["x-request-id"]).toBe("web-7f3c2a10-abcd");
  });

  it.each([
    ["markup", "<script>alert(1)</script>"],
    ["too short", "abc"],
    ["too long", "a".repeat(65)],
    ["spaces", "req 1 forged line"],
  ])("replaces a caller's id that is not (%s)", async (_label, value) => {
    const response = await app.inject({
      method: "GET",
      url: "/health/liveness",
      headers: { "x-request-id": value },
    });

    expect(response.headers["x-request-id"]).toMatch(UUID_V7);
    expect(lines().map((line) => line.reqId)).not.toContain(value);
  });

  it("is in the body of a 500, the one thing support can be quoted", async () => {
    const response = await app.inject({ method: "GET", url: "/__test__/boom" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      requestId: response.headers["x-request-id"],
    });
  });
});

describe("an authenticated request", () => {
  it("names the user and the tenant on its closing line", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/__test__/whoami",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);

    const completed = lines().find(
      (line) =>
        line.msg === "request completed" &&
        line.reqId === response.headers["x-request-id"],
    );

    expect(completed).toMatchObject({ userId: USER, businessId: BUSINESS });
  });

  it("by an API key names the key and the tenant the same way", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/__test__/machine",
      headers: { authorization: `Bearer ${apiKeyToken}` },
    });

    expect(response.statusCode).toBe(200);

    const completed = lines().find(
      (line) =>
        line.msg === "request completed" &&
        line.reqId === response.headers["x-request-id"],
    );

    expect(completed).toMatchObject({ apiKeyId, businessId: BUSINESS });
  });
});

describe("an event published by a request", () => {
  it("keeps the request id as its correlation id", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/__test__/publish",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);

    const [event] = await prisma.domainOutboxEvent.findMany();

    expect(event.correlationId).toBe(response.headers["x-request-id"]);
  });

  it("has none when published outside a request (a cron, a worker)", async () => {
    const { OutboxService } = await import(
      "@/shared/notifications/outbox-service"
    );
    const { withoutRequestContext } = await import(
      "@/shared/http/request-context"
    );

    // As a worker runs. `inject` calls the request hooks from this test's own
    // async context, so the previous request's scope would otherwise still be
    // entered here — a leak a real socket-borne request cannot have.
    await withoutRequestContext(() =>
      new OutboxService().publishAfterCommit({
        topic: "account-payable.created",
        aggregateType: "account-payable",
        aggregateId: randomUUID(),
        businessId: BUSINESS,
        actorId: USER,
        payload: {
          accountPayableId: randomUUID(),
          businessId: BUSINESS,
          amount: 1,
          serviceOrderId: null,
          registrationUserId: USER,
        },
      }),
    );

    const [event] = await prisma.domainOutboxEvent.findMany();

    expect(event.correlationId).toBeNull();
  });
});

describe("what the pipeline writes about each delivery", () => {
  it("one line per accepted delivery, with everything needed to find it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/__test__/publish",
      headers: { authorization: `Bearer ${token}` },
    });
    const requestId = response.headers["x-request-id"];

    await drainUntil(async () => {
      const rows = await prisma.notificationDelivery.findMany();

      return rows.length > 0 && rows.every((row) => row.status === "DELIVERED");
    });

    const [event] = await prisma.domainOutboxEvent.findMany();
    const rows = await prisma.notificationDelivery.findMany();
    const email = rows.find((row) => row.channel === "EMAIL")!;

    const accepted = lines().filter(
      (line) => line.msg === "notification delivery accepted",
    );

    expect(accepted).toHaveLength(rows.length);

    expect(accepted.find((line) => line.deliveryId === email.id)).toMatchObject(
      {
        level: 30,
        component: "notification-pipeline",
        deliveryId: email.id,
        outboxEventId: event.id,
        correlationId: requestId,
        topic: "account-payable.created",
        businessId: BUSINESS,
        channel: "EMAIL",
        attempt: 1,
        providerMessageId: "<m@x>",
      },
    );
  });

  it("a failed attempt is a warn line with the same fields and the reason", async () => {
    mail.behaviour = async () => {
      throw new Error("provedor fora do ar");
    };

    const response = await app.inject({
      method: "POST",
      url: "/__test__/publish",
      headers: { authorization: `Bearer ${token}` },
    });

    const failures = () =>
      lines().filter((line) => line.msg === "notification delivery failed");

    await drainUntil(() => failures().length > 0);

    const [event] = await prisma.domainOutboxEvent.findMany();

    expect(failures()[0]).toMatchObject({
      level: 40,
      component: "notification-pipeline",
      outboxEventId: event.id,
      correlationId: response.headers["x-request-id"],
      topic: "account-payable.created",
      businessId: BUSINESS,
      channel: "EMAIL",
      attempt: 1,
      willRetry: true,
      error: "provedor fora do ar",
    });
  });
});
