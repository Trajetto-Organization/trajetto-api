import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { createHmac, randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { env } from "@/env";
import { MailDeliveryError } from "@/shared/providers/mail-provider/errors/mail-delivery-error";

/**
 * OBS-08: DELIVERED means "the provider accepted it", and until now that was
 * all anyone could know.
 *
 *  - A refusal lost its specifics on the way to lastError: Meta's HTTP status
 *    and error code, the SMTP code and reply. An expired token read like any
 *    other failure — nothing could alert on it, nobody could search for it.
 *  - An e-mail that bounced after Resend accepted it stayed DELIVERED for
 *    good: there was no receiver for Resend's delivery/bounce/complaint
 *    webhook. It now lands in the receipts ledger, tied to the delivery by
 *    the Message-ID the pipeline sets (the same header Resend reports back).
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const BUSINESS = "018fc000-0000-7000-8000-000000000f81";
const USER = "018fc000-0000-7000-8000-000000000f82";

const KEY = Buffer.from("chave-do-webhook-do-resend-teste");
const SECRET = `whsec_${KEY.toString("base64")}`;

const saved = { secret: env.RESEND_WEBHOOK_SECRET };

const providers = {
  whatsapp: null as null | Record<string, unknown>,
  mail: null as null | Error,
};

async function seedDelivery(
  channel: "WHATSAPP" | "EMAIL",
  overrides: { status?: "PENDING" | "DELIVERED"; providerMessageId?: string } = {},
): Promise<string> {
  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `provider-truth:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      actorId: USER,
      status: "PUBLISHED",
      payload: {
        accountPayableId: randomUUID(),
        businessId: BUSINESS,
        amount: 150,
        serviceOrderId: null,
        registrationUserId: USER,
      },
    },
  });

  const delivery = await prisma.notificationDelivery.create({
    data: {
      outboxEventId: event.id,
      userId: USER,
      channel,
      status: overrides.status ?? "PENDING",
      availableAt: new Date(Date.now() - 1_000),
      ...(overrides.status === "DELIVERED"
        ? { attempts: 1, deliveredAt: new Date() }
        : {}),
      providerMessageId: overrides.providerMessageId ?? null,
    },
  });

  return delivery.id;
}

function signed(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const id = `msg_${randomUUID()}`;
  const signature = createHmac("sha256", KEY)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");

  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": `v1,${signature}`,
  };
}

function resendEvent(
  type: string,
  data: Record<string, unknown>,
  createdAt = new Date().toISOString(),
): string {
  return JSON.stringify({ type, created_at: createdAt, data });
}

function postResend(body: string, headers: Record<string, string> = signed(body)) {
  return app.inject({
    method: "POST",
    url: "/webhooks/resend",
    headers,
    payload: body,
  });
}

async function cleanTables(): Promise<void> {
  await prisma.domainOutboxEvent.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.notificationProviderReceipt.deleteMany({
    where: { provider: "resend", deliveryId: null },
  });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora da Verdade da Entrega",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444000887",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `verdade-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa da Verdade",
      email: `verdade-${randomUUID()}@exemplo.com.br`,
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
    sendMail: async () => {
      if (providers.mail) throw providers.mail;
      return { messageId: `<${randomUUID()}@x>` };
    },
  });

  container.registerInstance("WhatsAppProvider", {
    isConfigured: () => true,
    sendMessage: async () =>
      providers.whatsapp ?? { success: true, retryable: false, messageId: "wamid.ok" },
  });

  pipeline = (
    await import("@/shared/notifications/notification-pipeline-service")
  ).NotificationPipelineService.getInstance();
}, 120_000);

beforeEach(async () => {
  env.RESEND_WEBHOOK_SECRET = SECRET;
  providers.whatsapp = null;
  providers.mail = null;

  await cleanTables();
});

afterAll(async () => {
  env.RESEND_WEBHOOK_SECRET = saved.secret;

  await cleanTables();
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a refusal the provider explained", () => {
  it("keeps Meta's HTTP status and error code in lastError", { timeout: 30_000 }, async () => {
    providers.whatsapp = {
      success: false,
      retryable: false,
      httpStatus: 401,
      errorCode: 190,
      message: "Error validating access token: Session has expired",
    };

    const id = await seedDelivery("WHATSAPP");

    await pipeline.runDeliveryCycle("external");

    const row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });

    expect(row.status).toBe("FAILED");
    expect(row.lastError).toBe(
      "[whatsapp http=401 code=190] Error validating access token: Session has expired",
    );
  });

  it("keeps the SMTP code and reply of an e-mail refusal", { timeout: 30_000 }, async () => {
    providers.mail = new MailDeliveryError("Falha ao enviar e-mail: Invalid login", {
      retryable: false,
      code: "EAUTH",
      responseCode: 535,
    });

    const id = await seedDelivery("EMAIL");

    await pipeline.runDeliveryCycle("external");

    const row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });

    expect(row.status).toBe("FAILED");
    expect(row.lastError).toBe(
      "[email smtp=EAUTH reply=535] Falha ao enviar e-mail: Invalid login",
    );
  });

  it("keeps it on a retryable refusal too, and still retries", { timeout: 30_000 }, async () => {
    providers.mail = new MailDeliveryError("Falha ao enviar e-mail: try later", {
      retryable: true,
      responseCode: 451,
    });

    const id = await seedDelivery("EMAIL");

    await pipeline.runDeliveryCycle("external");

    const row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });

    expect(row.status).toBe("PENDING");
    expect(row.lastError).toBe("[email reply=451] Falha ao enviar e-mail: try later");
  });
});

describe("Resend's word on an e-mail it accepted", () => {
  it("does not exist while the environment has no signing secret", async () => {
    env.RESEND_WEBHOOK_SECRET = undefined;

    const response = await postResend(resendEvent("email.delivered", { email_id: "re_1" }));

    expect(response.statusCode).toBe(404);
  });

  it("refuses a body Resend did not sign", async () => {
    const body = resendEvent("email.bounced", { email_id: "re_1" });

    const response = await postResend(body, {
      ...signed(body),
      "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });

    expect(response.statusCode).toBe(401);
  });

  it("ties a bounce to the delivery by its Message-ID and marks it", async () => {
    const id = await seedDelivery("EMAIL", {
      status: "DELIVERED",
      providerMessageId: "<pipeline-message-id@intrajetto.com>",
    });

    // The Message-ID the pipeline builds carries the delivery id.
    const messageId = `<${id}@intrajetto.com>`;
    const emailId = randomUUID();

    const response = await postResend(
      resendEvent("email.bounced", {
        email_id: emailId,
        message_id: messageId,
        to: ["ana@exemplo.com"],
        bounce: { type: "Permanent", subType: "General", message: "550 <ana@exemplo.com> unknown" },
      }),
    );

    expect(response.statusCode).toBe(200);

    const row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.providerStatus).toBe("bounced");

    const receipts = await prisma.notificationProviderReceipt.findMany({
      where: { deliveryId: id },
    });

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      provider: "resend",
      providerMessageId: emailId,
      status: "bounced",
      errorCode: "Permanent/General",
    });
    expect(receipts[0].errorMessage).not.toContain("ana@exemplo.com");
  });

  it("finds the delivery by the Message-ID it recorded, and never moves it backwards", async () => {
    const recorded = "<recorded-by-the-pipeline@intrajetto.com>";
    const id = await seedDelivery("EMAIL", {
      status: "DELIVERED",
      providerMessageId: recorded,
    });

    const emailId = randomUUID();

    await postResend(resendEvent("email.complained", { email_id: emailId, message_id: recorded }));
    await postResend(resendEvent("email.delivered", { email_id: emailId, message_id: recorded }));

    const row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.providerStatus).toBe("complained");

    const statuses = (
      await prisma.notificationProviderReceipt.findMany({ where: { deliveryId: id } })
    ).map((receipt) => receipt.status);

    expect(statuses.sort()).toEqual(["complained", "delivered"]);
  });

  it("absorbs a callback Resend delivers twice", async () => {
    const id = await seedDelivery("EMAIL", { status: "DELIVERED" });
    const body = resendEvent("email.delivered", {
      email_id: "re-twice",
      message_id: `<${id}@intrajetto.com>`,
    });

    expect((await postResend(body)).statusCode).toBe(200);
    expect((await postResend(body)).statusCode).toBe(200);

    expect(
      await prisma.notificationProviderReceipt.count({ where: { deliveryId: id } }),
    ).toBe(1);
  });

  it("keeps a report no delivery claims, untied", async () => {
    const emailId = randomUUID();

    const response = await postResend(
      resendEvent("email.bounced", {
        email_id: emailId,
        message_id: "<111-222-333@email.example.com>",
      }),
    );

    expect(response.statusCode).toBe(200);

    const receipt = await prisma.notificationProviderReceipt.findFirstOrThrow({
      where: { provider: "resend", providerMessageId: emailId },
    });

    expect(receipt.deliveryId).toBeNull();
  });

  it("answers 200 to an event it does not track", async () => {
    const response = await postResend(resendEvent("email.opened", { email_id: "re_x" }));

    expect(response.statusCode).toBe(200);
  });
});
