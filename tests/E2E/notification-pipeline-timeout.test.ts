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

import { container } from "tsyringe";

/**
 * A provider that answers after the pipeline stopped waiting for it.
 *
 * `withDeliveryTimeout` stops WAITING at PER_DELIVERY_TIMEOUT_MS; it cannot
 * cancel the call already on the wire. The pipeline used to treat that moment
 * as a failed send: the row went back to PENDING for ~30s while the provider
 * went on to accept the message, and the retry sent it a second time. E-mail
 * has an idempotency key at Resend to absorb that; WhatsApp and push do not.
 *
 * The budget is shrunk to one second here so the case runs in real time. The
 * provider takes 2.5s — past the budget, well inside the 180s lease.
 */
vi.mock("@/shared/notifications/pipeline-rules", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/shared/notifications/pipeline-rules")
  >()),
  PER_DELIVERY_TIMEOUT_MS: 1_000,
}));

const PROVIDER_DELAY_MS = 2_500;

const prisma = new PrismaClient();

let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const BUSINESS = "018fc000-0000-7000-8000-0000000006b1";
const RECIPIENT = "018fc000-0000-7000-8000-0000000006c1";

const mail = {
  sent: [] as Array<{ referenceId?: string }>,
  outcome: "accept" as "accept" | "refuse",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An expanded event whose e-mail is the only row left to send. */
async function emailRow(): Promise<string> {
  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `account-payable.created:${randomUUID()}`,
      topic: "account-payable.created",
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

  await pipeline.runOutboxCycle();

  await prisma.notificationDelivery.updateMany({
    where: { outboxEventId: event.id, channel: { not: "EMAIL" } },
    data: { status: "DELIVERED", deliveredAt: new Date() },
  });

  return (
    await prisma.notificationDelivery.findFirstOrThrow({
      where: { outboxEventId: event.id, channel: "EMAIL" },
    })
  ).id;
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Provedor Lento",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444000363",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `lento-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: RECIPIENT,
      name: "Pessoa Destinatária",
      email: `destinataria-lento-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  const { app } = await import("@/http");
  await app.ready();

  container.registerInstance("MailProvider", {
    sendMail: async (message: { referenceId?: string }) => {
      // The request is on the wire from the first instant: counted now, the
      // way the recipient would count it.
      mail.sent.push(message);

      await sleep(PROVIDER_DELAY_MS);

      if (mail.outcome === "refuse") {
        throw new Error("SMTP 451: tente novamente mais tarde");
      }

      return { messageId: `<${randomUUID()}@x>` };
    },
  });

  const pipelineModule = await import(
    "@/shared/notifications/notification-pipeline-service"
  );

  pipeline = pipelineModule.NotificationPipelineService.getInstance();
}, 120_000);

beforeEach(async () => {
  mail.sent = [];
  mail.outcome = "accept";

  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
});

afterAll(async () => {
  // Let any send still in flight settle before the database goes away.
  await sleep(PROVIDER_DELAY_MS);

  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.$disconnect();
}, 60_000);

describe("a send that outlives the pipeline's patience", () => {
  it(
    "is recorded as what the provider answered, and never sent twice",
    { timeout: 30_000 },
    async () => {
      const id = await emailRow();

      await pipeline.runDeliveryCycle("external");

      // The worker moved on; the row is still this claim's, under its lease.
      // Back in PENDING it would be on a ~30s timer to a second copy.
      const meanwhile = await prisma.notificationDelivery.findUniqueOrThrow({
        where: { id },
      });

      expect(meanwhile.status).toBe("PROCESSING");

      // The provider accepts.
      await sleep(PROVIDER_DELAY_MS);

      // Whatever the row says now, make it due, the way the clock eventually
      // would, and run the lane again.
      await prisma.notificationDelivery.updateMany({
        where: { id, status: "PENDING" },
        data: { availableAt: new Date() },
      });

      await pipeline.runDeliveryCycle("external");
      await sleep(PROVIDER_DELAY_MS);

      expect(mail.sent, "o mesmo e-mail saiu duas vezes").toHaveLength(1);

      const row = await prisma.notificationDelivery.findUniqueOrThrow({
        where: { id },
      });

      expect(row.status).toBe("DELIVERED");
      expect(row.attempts).toBe(1);
      expect(row.providerMessageId).toBeTruthy();
    },
  );

  it(
    "is retried on the schedule when the provider finally refuses it",
    { timeout: 30_000 },
    async () => {
      mail.outcome = "refuse";

      const id = await emailRow();

      await pipeline.runDeliveryCycle("external");
      await sleep(PROVIDER_DELAY_MS + 500);

      const row = await prisma.notificationDelivery.findUniqueOrThrow({
        where: { id },
      });

      // The real reason, not "the pipeline got bored": what support reads in
      // the dead letter has to be what the provider said.
      expect(row.status).toBe("PENDING");
      expect(row.lastError).toContain("SMTP 451");
      expect(row.attempts).toBe(1);
      expect(row.availableAt.getTime()).toBeGreaterThan(Date.now() + 10_000);
      expect(mail.sent).toHaveLength(1);
    },
  );
});
