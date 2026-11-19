import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  businessDateKey,
  businessDayStart,
  shiftDateKey,
} from "@/shared/time/business-day";

/**
 * Each company's daily WhatsApp quota, through the real pipeline
 * (plano-escala F3-15b; decision D46).
 *
 *  - with WHATSAPP_DAILY_QUOTA_PER_TENANT=3, the 4th WhatsApp of the
 *    company's day waits for its next business day, without spending an
 *    attempt and without an e-mail in its place;
 *  - the admins hear of it in the bell once that day, however many wait;
 *  - a call Meta refused for rate (130429) gives its unit back;
 *  - with 0, nothing changes: the four go out.
 */
const prisma = createPrismaClient();

const BUSINESS = "018fc000-0000-7000-8000-0000000015b1";
const ADMIN = "018fc000-0000-7000-8000-0000000015c1";
const ACTOR = "018fc000-0000-7000-8000-0000000015c2";
const TIME_ZONE = "America/Sao_Paulo";

type Pipeline =
  import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

let pipeline: Pipeline;
let app: Awaited<typeof import("@/http")>["app"];

const whatsapp = {
  sent: [] as Array<{ referenceId?: string }>,

  /** How many of the next calls Meta refuses for rate (130429). */
  refuseForRate: 0,
};
const mail = { sent: [] as Array<{ referenceId?: string }> };

const saved = env.WHATSAPP_DAILY_QUOTA_PER_TENANT;

/** A bill registered by ACTOR for ADMIN: a WhatsApp to the admin. */
async function publish(): Promise<string> {
  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `account-payable.created:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      actorId: ACTOR,
      payload: {
        accountPayableId: randomUUID(),
        businessId: BUSINESS,
        amount: 150,
        serviceOrderId: null,
        registrationUserId: ADMIN,
      },
    },
  });

  return event.id;
}

/** Until nothing is due: the notice's own bell rows included. */
async function drain(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await pipeline.runOutboxCycle();
    await pipeline.runDeliveryCycle("internal");
    await pipeline.runDeliveryCycle("external");
  }
}

async function whatsAppRows() {
  return prisma.notificationDelivery.findMany({
    where: { channel: "WHATSAPP", userId: ADMIN },
  });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora da Cota",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444001601",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `cota-${randomUUID()}@exemplo.com.br`,
      timezone: TIME_ZONE,
    },
  });

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Pessoa Administradora",
      email: `cota-admin-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
      whatsapp_phone: "5511999990000",
      whatsapp_notifications_enabled: true,
    },
  });

  await prisma.user.create({
    data: {
      id: ACTOR,
      name: "Pessoa do Escritório",
      email: `cota-escritorio-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();

  // After the app registered the real providers: the last one wins.
  container.registerInstance("MailProvider", {
    sendMail: async (message: { referenceId?: string }) => {
      mail.sent.push(message);
      return { messageId: "<m@x>" };
    },
  });

  container.registerInstance("WhatsAppProvider", {
    isConfigured: () => true,
    sendMessage: async (props: { referenceId?: string }) => {
      if (whatsapp.refuseForRate > 0) {
        whatsapp.refuseForRate -= 1;

        return {
          success: false,
          retryable: true,
          httpStatus: 400,
          errorCode: 130429,
          message: "(#130429) Rate limit hit",
        };
      }

      whatsapp.sent.push(props);
      return { success: true, messageId: `wamid.${randomUUID()}` };
    },
  });

  const pipelineModule =
    await import("@/shared/notifications/notification-pipeline-service");

  pipeline = pipelineModule.NotificationPipelineService.getInstance();
}, 120_000);

beforeEach(async () => {
  whatsapp.sent = [];
  whatsapp.refuseForRate = 0;
  mail.sent = [];

  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.$executeRawUnsafe(`DELETE FROM "outbox_event_key"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "provider_quota_day"`);
  await prisma.notification.deleteMany({ where: { userId: ADMIN } });
});

afterAll(async () => {
  env.WHATSAPP_DAILY_QUOTA_PER_TENANT = saved;

  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.notification.deleteMany({
    where: { userId: { in: [ADMIN, ACTOR] } },
  });
  await prisma.activity.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.user.deleteMany({ where: { id: { in: [ADMIN, ACTOR] } } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the company's daily WhatsApp quota", () => {
  it("holds the 4th of the day until the company's next day, without spending an attempt", async () => {
    env.WHATSAPP_DAILY_QUOTA_PER_TENANT = 3;

    for (let n = 0; n < 4; n += 1) await publish();

    await drain();

    expect(whatsapp.sent).toHaveLength(3);

    const rows = await whatsAppRows();
    const held = rows.filter((row) => row.status === "PENDING");

    expect(rows.filter((row) => row.status === "DELIVERED")).toHaveLength(3);
    expect(held).toHaveLength(1);

    // Not an attempt: the claim's is given back.
    expect(held[0].attempts).toBe(0);
    expect(held[0].lastError).toContain("Cota diária de WhatsApp");

    // The company's next business day, in its own time zone.
    const today = businessDateKey(new Date(), TIME_ZONE);

    expect(held[0].availableAt.toISOString()).toBe(
      businessDayStart(shiftDateKey(today, 1), TIME_ZONE).toISOString(),
    );

    // Counted in Postgres, by the company's day.
    const [day] = await prisma.$queryRawUnsafe<
      Array<{ used: number; day: string }>
    >(
      `SELECT "used", "day"::text AS day FROM "provider_quota_day" WHERE "provider" = 'whatsapp' AND "scope" = $1`,
      `whatsapp:${BUSINESS}`,
    );

    expect(day).toEqual({ used: 3, day: today });
  });

  it("holds them a millisecond apart from the company's next day, in the order they were held", async () => {
    // All held at the day's start, they became due at one instant, and
    // the claims (by availableAt alone) took them in no order: the next
    // day's quota went to any of them, against the bell's "na ordem em
    // que chegaram".
    env.WHATSAPP_DAILY_QUOTA_PER_TENANT = 1;

    const today = businessDateKey(new Date(), TIME_ZONE);
    const start = businessDayStart(shiftDateKey(today, 1), TIME_ZONE);

    // A retry of another message scheduled past midnight is not one of
    // the held: they do not queue behind it.
    const retry = await prisma.notificationDelivery.create({
      data: {
        outboxEventId: randomUUID(),
        userId: ACTOR,
        channel: "WHATSAPP",
        status: "PENDING",
        attempts: 3,
        availableAt: new Date(start.getTime() + 2 * 3_600_000),
        business_id: BUSINESS,
        lastError: "[whatsapp http=500] Falha temporária da Meta",
      },
    });

    // One at a time: the order they are held in is the order they came.
    const events: string[] = [];

    for (let n = 0; n < 4; n += 1) {
      events.push(await publish());
      await drain();
    }

    expect(whatsapp.sent).toHaveLength(1);

    const rows = await whatsAppRows();
    const held = events
      .map((event) => rows.find((row) => row.outboxEventId === event)!)
      .filter((row) => row.status === "PENDING");

    expect(held).toHaveLength(3);
    expect(
      held.map((row) => row.availableAt.getTime() - start.getTime()),
    ).toEqual([0, 1, 2]);

    // The retry keeps its own time.
    expect(
      (
        await prisma.notificationDelivery.findUniqueOrThrow({
          where: { id: retry.id },
        })
      ).availableAt.getTime(),
    ).toBe(start.getTime() + 2 * 3_600_000);
  });

  it("tells the admins once a day, in the bell only, however many wait", async () => {
    env.WHATSAPP_DAILY_QUOTA_PER_TENANT = 1;

    for (let n = 0; n < 3; n += 1) await publish();

    await drain();

    // A fourth held later the same day: no second notice.
    await publish();
    await drain();

    expect(whatsapp.sent).toHaveLength(1);

    const notices = await prisma.domainOutboxEvent.findMany({
      where: { topic: "whatsapp-quota.reached" },
    });

    expect(notices).toHaveLength(1);
    expect(notices[0].businessId).toBe(BUSINESS);

    const bell = await prisma.notification.findMany({
      where: { userId: ADMIN, title: "Cota diária de WhatsApp atingida" },
    });

    expect(bell).toHaveLength(1);

    // No e-mail about it, and none in place of the held WhatsApp.
    const noticeRows = await prisma.notificationDelivery.findMany({
      where: { outboxEventId: notices[0].id },
    });

    expect(noticeRows.map((row) => row.channel)).not.toContain("EMAIL");
    expect(
      (await whatsAppRows()).filter((row) => row.status === "PENDING"),
    ).toHaveLength(3);
  });

  it("gives back the unit of a call Meta refused for rate", async () => {
    // Meta did not take the call: counted, the retries while it throttles
    // spent the company's day on nothing, and the rest of the day's
    // messages waited for tomorrow.
    env.WHATSAPP_DAILY_QUOTA_PER_TENANT = 2;
    whatsapp.refuseForRate = 1;

    const used = async () =>
      (
        await prisma.$queryRawUnsafe<Array<{ used: number }>>(
          `SELECT "used" FROM "provider_quota_day" WHERE "provider" = 'whatsapp' AND "scope" = $1`,
          `whatsapp:${BUSINESS}`,
        )
      ).reduce((total, row) => total + Number(row.used), 0);

    await publish();
    await drain();

    const [refused] = await whatsAppRows();

    expect(whatsapp.sent).toHaveLength(0);
    expect(refused.status).toBe("PENDING");
    expect(refused.lastError).toMatch(/130429/);
    expect(await used()).toBe(0);

    // Due again, Meta takes it, and only that call is counted.
    await prisma.notificationDelivery.update({
      where: { id: refused.id },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });
    await drain();

    expect(whatsapp.sent).toHaveLength(1);
    expect(await used()).toBe(1);
  });

  it("changes nothing with the quota off", async () => {
    env.WHATSAPP_DAILY_QUOTA_PER_TENANT = 0;

    for (let n = 0; n < 4; n += 1) await publish();

    await drain();

    expect(whatsapp.sent).toHaveLength(4);
    expect(
      await prisma.$queryRawUnsafe<unknown[]>(
        `SELECT 1 FROM "provider_quota_day" WHERE "provider" = 'whatsapp'`,
      ),
    ).toHaveLength(0);
  });
});
