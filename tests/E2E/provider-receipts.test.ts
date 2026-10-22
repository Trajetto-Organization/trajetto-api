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
import { createHmac, randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { env } from "@/env";

/**
 * What a provider says happened to a message AFTER it accepted it.
 *
 * WhatsApp and Expo have no idempotency key: a send retried after a crash
 * reaches the recipient twice, and before this nothing could even tell. The
 * ledger (notification_provider_receipt) records every report a provider
 * makes — Meta's status callbacks, Expo's tickets and receipts — tied to the
 * delivery that produced the message, so "we sent it twice" and "it failed
 * after being accepted" become answerable after the fact.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const BUSINESS = "018fc000-0000-7000-8000-000000000eb1";
const USER = "018fc000-0000-7000-8000-000000000ec1";

const APP_SECRET = "segredo-do-app-de-teste";
const VERIFY_TOKEN = "token-de-verificacao-de-teste";

const saved = {
  secret: env.META_WHATSAPP_APP_SECRET,
  verify: env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN,
};

const whatsapp = {
  sent: [] as Array<{ phoneNumber: string; referenceId?: string }>,
};

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function statusCallback(
  statuses: Array<{
    id: string;
    status: string;
    timestamp?: string;
    biz_opaque_callback_data?: string;
    errors?: Array<{ code: number; title: string }>;
  }>,
): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "1234567890" },
              statuses: statuses.map((status) => ({
                recipient_id: "5511999990000",
                timestamp: String(Math.floor(Date.now() / 1000)),
                ...status,
              })),
            },
          },
        ],
      },
    ],
  });
}

function postCallback(body: string, signature = sign(body)) {
  return app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
    },
    payload: body,
  });
}

/** A delivery row as the pipeline leaves it once Meta accepted the send. */
async function seedDelivery(
  channel: "WHATSAPP" | "PUSH" = "WHATSAPP",
): Promise<string> {
  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `receipts:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      payload: {},
      status: "PUBLISHED",
    },
  });

  const delivery = await prisma.notificationDelivery.create({
    data: {
      outboxEventId: event.id,
      userId: USER,
      channel,
      status: "DELIVERED",
      attempts: 1,
      deliveredAt: new Date(),
      providerMessageId: channel === "WHATSAPP" ? "wamid.first" : null,
    },
  });

  return delivery.id;
}

/**
 * This file's rows only: E2E files run in parallel. Deliveries go with their
 * events, tied receipts with their deliveries; the untied Meta and Expo ones
 * are this file's own (delivery-provider-truth writes the Resend ones).
 */
async function cleanTables(): Promise<void> {
  await prisma.domainOutboxEvent.deleteMany({
    where: { businessId: BUSINESS },
  });
  await prisma.notificationProviderReceipt.deleteMany({
    where: { deliveryId: null, provider: { in: ["meta", "expo"] } },
  });
  await prisma.pushDeviceToken.deleteMany({ where: { userId: USER } });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora dos Recibos",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444000941",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `recibos-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa dos Recibos",
      email: `recibos-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
      whatsapp_phone: "5511999990000",
      whatsapp_notifications_enabled: true,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();

  container.registerInstance("MailProvider", {
    sendMail: async () => ({ messageId: "<m@x>" }),
  });

  container.registerInstance("WhatsAppProvider", {
    isConfigured: () => true,
    sendMessage: async (props: {
      phoneNumber: string;
      referenceId?: string;
    }) => {
      whatsapp.sent.push(props);
      return { success: true, messageId: "wamid.pipeline" };
    },
  });

  pipeline = (
    await import("@/shared/notifications/notification-pipeline-service")
  ).NotificationPipelineService.getInstance();
}, 120_000);

beforeEach(async () => {
  env.META_WHATSAPP_APP_SECRET = APP_SECRET;
  env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;

  whatsapp.sent = [];

  await cleanTables();

  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  env.META_WHATSAPP_APP_SECRET = saved.secret;
  env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN = saved.verify;

  vi.unstubAllGlobals();

  await cleanTables();
  await prisma.notification.deleteMany({ where: { userId: USER } });
  await prisma.activity.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("Meta's subscription handshake", () => {
  it("echoes the challenge when the verify token matches", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("1158201444");
  });

  it("refuses a wrong verify token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=outro&hub.challenge=1",
    });

    expect(response.statusCode).toBe(403);
  });

  it("does not exist while the environment has no verify token", async () => {
    env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN = undefined;

    const response = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=1",
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("a status callback", () => {
  it("lands in the ledger, tied to the delivery named by the callback data", async () => {
    const deliveryId = await seedDelivery();

    const response = await postCallback(
      statusCallback([
        {
          id: "wamid.first",
          status: "delivered",
          biz_opaque_callback_data: deliveryId,
        },
      ]),
    );

    expect(response.statusCode).toBe(200);

    const receipts = await prisma.notificationProviderReceipt.findMany({});

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      provider: "meta",
      providerMessageId: "wamid.first",
      status: "delivered",
      deliveryId,
    });

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

    expect(delivery.providerStatus).toBe("delivered");
    expect(delivery.providerStatusAt).not.toBeNull();
  });

  it("is a no-op when Meta sends it again", async () => {
    // Meta retries a callback it did not see a 200 for, for days.
    const deliveryId = await seedDelivery();

    const body = statusCallback([
      {
        id: "wamid.first",
        status: "sent",
        biz_opaque_callback_data: deliveryId,
      },
    ]);

    expect((await postCallback(body)).statusCode).toBe(200);
    expect((await postCallback(body)).statusCode).toBe(200);

    expect(await prisma.notificationProviderReceipt.count()).toBe(1);
  });

  it("finds the delivery by the wamid when the callback carries no data", async () => {
    // Messages sent before the delivery id travelled with them.
    const deliveryId = await seedDelivery();

    await postCallback(statusCallback([{ id: "wamid.first", status: "read" }]));

    const [receipt] = await prisma.notificationProviderReceipt.findMany({});

    expect(receipt.deliveryId).toBe(deliveryId);
  });

  it("never moves the delivery's status backwards", async () => {
    // Callbacks arrive out of order; a late 'sent' must not undo a 'read'.
    const deliveryId = await seedDelivery();

    await postCallback(
      statusCallback([
        {
          id: "wamid.first",
          status: "read",
          biz_opaque_callback_data: deliveryId,
        },
      ]),
    );

    await postCallback(
      statusCallback([
        {
          id: "wamid.first",
          status: "sent",
          biz_opaque_callback_data: deliveryId,
        },
      ]),
    );

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

    expect(delivery.providerStatus).toBe("read");
    expect(await prisma.notificationProviderReceipt.count()).toBe(2);
  });

  it("keeps a failure reported after acceptance, with Meta's code", async () => {
    const deliveryId = await seedDelivery();

    await postCallback(
      statusCallback([
        {
          id: "wamid.first",
          status: "failed",
          biz_opaque_callback_data: deliveryId,
          errors: [{ code: 131026, title: "Message undeliverable" }],
        },
      ]),
    );

    const [receipt] = await prisma.notificationProviderReceipt.findMany({});

    expect(receipt).toMatchObject({
      status: "failed",
      errorCode: "131026",
      deliveryId,
    });

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

    expect(delivery.providerStatus).toBe("failed");
  });

  it("makes a second send of the same delivery visible: two wamids, one delivery", async () => {
    // The scenario the ledger exists for: Meta accepted, the process died
    // before DELIVERED was written, the lease expired and the row was sent
    // again. Only the callback data can tie the first wamid back.
    const deliveryId = await seedDelivery();

    await postCallback(
      statusCallback([
        {
          id: "wamid.lost",
          status: "sent",
          biz_opaque_callback_data: deliveryId,
        },
        {
          id: "wamid.first",
          status: "sent",
          biz_opaque_callback_data: deliveryId,
        },
      ]),
    );

    const wamids = await prisma.notificationProviderReceipt.findMany({
      where: { deliveryId },
      distinct: ["providerMessageId"],
    });

    expect(wamids.map((row) => row.providerMessageId).sort()).toEqual([
      "wamid.first",
      "wamid.lost",
    ]);
  });

  it("keeps a report for a delivery nobody knows, untied", async () => {
    await postCallback(
      statusCallback([
        {
          id: "wamid.orphan",
          status: "delivered",
          biz_opaque_callback_data: randomUUID(),
        },
      ]),
    );

    const [receipt] = await prisma.notificationProviderReceipt.findMany({});

    expect(receipt.deliveryId).toBeNull();
  });

  it("refuses a body whose signature does not match, and records nothing", async () => {
    const deliveryId = await seedDelivery();

    const body = statusCallback([
      {
        id: "wamid.first",
        status: "read",
        biz_opaque_callback_data: deliveryId,
      },
    ]);

    const response = await postCallback(body, sign(body, "outro-segredo"));

    expect(response.statusCode).toBe(401);
    expect(await prisma.notificationProviderReceipt.count()).toBe(0);
  });

  it("refuses a body with no signature at all", async () => {
    const body = statusCallback([{ id: "wamid.first", status: "read" }]);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json" },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("what the pipeline hands the providers", () => {
  it("sends the delivery id with every WhatsApp, so its callbacks come back tied", async () => {
    const event = await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `receipts:${randomUUID()}`,
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
      },
    });

    await pipeline.runOutboxCycle();
    await pipeline.runDeliveryCycle("external");

    const row = await prisma.notificationDelivery.findFirstOrThrow({
      where: { outboxEventId: event.id, channel: "WHATSAPP" },
    });

    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0].referenceId).toBe(row.id);
  });

  it("records one Expo ticket per device and prunes a device the receipt says is gone", async () => {
    await prisma.pushDeviceToken.create({
      data: {
        userId: USER,
        token: "ExponentPushToken[morto]",
        platform: "android",
      },
    });

    const expoCalls: Array<{ url: string; body: unknown }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        expoCalls.push({ url, body: JSON.parse(init.body) });

        return new Response(
          JSON.stringify({ data: [{ status: "ok", id: "ticket-1" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `receipts:${randomUUID()}`,
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
      },
    });

    await pipeline.runOutboxCycle();
    await pipeline.runDeliveryCycle("internal");

    const push = await prisma.notificationDelivery.findFirstOrThrow({
      where: { channel: "PUSH", userId: USER },
    });

    expect(push.status).toBe("DELIVERED");

    // The delivery id rides in the push data, for the app and for support.
    const [sentMessage] = expoCalls[0].body as Array<{
      data: { deliveryId?: string };
    }>;
    expect(sentMessage.data.deliveryId).toBe(push.id);

    const [ticket] = await prisma.notificationProviderReceipt.findMany({});

    expect(ticket).toMatchObject({
      provider: "expo",
      providerMessageId: "ticket-1",
      status: "ticket",
      pushToken: "ExponentPushToken[morto]",
      deliveryId: push.id,
    });

    // Expo publishes the receipt some minutes later; the job asks after 15.
    await prisma.notificationProviderReceipt.update({
      where: { id: ticket.id },
      data: { created_at: new Date(Date.now() - 20 * 60 * 1000) },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                "ticket-1": {
                  status: "error",
                  message: "The recipient device is not registered with FCM.",
                  details: { error: "DeviceNotRegistered" },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const { checkPushReceiptsJob } = await import(
      "@/jobs/cron/check-push-receipts-job"
    );

    await checkPushReceiptsJob.handler();

    const checked = await prisma.notificationProviderReceipt.findUniqueOrThrow({
      where: { id: ticket.id },
    });

    expect(checked).toMatchObject({
      status: "error",
      errorCode: "DeviceNotRegistered",
    });
    expect(checked.checkedAt).not.toBeNull();

    expect(
      await prisma.pushDeviceToken.count({
        where: { token: "ExponentPushToken[morto]" },
      }),
    ).toBe(0);

    const settled = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: push.id },
    });

    expect(settled.providerStatus).toBe("error");
  });
});

describe("the ledger's retention", () => {
  it("purges a month-old report no delivery claims, which no cascade reaches", async () => {
    const old = await prisma.notificationProviderReceipt.create({
      data: {
        provider: "meta",
        providerMessageId: `wamid.velho-${randomUUID()}`,
        status: "delivered",
        occurredAt: new Date(),
        created_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      },
    });

    const recent = await prisma.notificationProviderReceipt.create({
      data: {
        provider: "meta",
        providerMessageId: `wamid.novo-${randomUUID()}`,
        status: "delivered",
        occurredAt: new Date(),
      },
    });

    const { cleanupNotificationPipelineJob } = await import(
      "@/jobs/cron/cleanup-notification-pipeline-job"
    );

    await cleanupNotificationPipelineJob.handler();

    const left = await prisma.notificationProviderReceipt.findMany({
      where: { id: { in: [old.id, recent.id] } },
    });

    expect(left.map((row) => row.id)).toEqual([recent.id]);
  });
});
