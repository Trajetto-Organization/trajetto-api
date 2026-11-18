import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The queues as continuous pools (plano-escala F3-06), against the real
 * claims.
 *
 * The lanes and the outbox claimed a batch and waited for the whole batch
 * before the next claim. One e-mail stuck on its 15 s backstop held the
 * slots that had already finished, so everything behind its batch waited
 * for it; and a deploy that arrived mid-batch left the claimed rows nobody
 * had started PROCESSING until their lease ran out — 180 s for a delivery.
 *
 *  - one held e-mail among thirty: the other twenty-nine go out while it is
 *    still held. With the barrier, the ten past the first batch of twenty
 *    waited for its backstop;
 *  - a stop while one event expands: the events claimed with it and not
 *    started go back at once (PENDING, the claim undone, due now), the one
 *    in flight finishes, and the next replica expands each of them once.
 */
const prisma = createPrismaClient();

const BUSINESS = "018fc000-0000-7000-8000-0000000013a1";
const RECIPIENT = "018fc000-0000-7000-8000-0000000013c1";

type Pipeline =
  import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

/** A fresh pipeline per "replica" (the constructor is private). */
async function newPipeline(): Promise<Pipeline> {
  const { NotificationPipelineService } =
    await import("@/shared/notifications/notification-pipeline-service");

  return new (NotificationPipelineService as unknown as new () => Pipeline)();
}

const mail = {
  sent: [] as string[],
  hold: null as Promise<void> | null,
  heldId: null as string | null,
};

async function publishEvents(
  count: number,
  status: "PENDING" | "PUBLISHED" = "PENDING",
): Promise<string[]> {
  const ids: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const event = await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `account-payable.created:${randomUUID()}`,
        topic: "account-payable.created",
        aggregateType: "account-payable",
        aggregateId: randomUUID(),
        businessId: BUSINESS,
        // Nobody's action: the bill's responsible is told of a bill
        // somebody else registered (actor-notice.test.ts).
        actorId: null,
        status,
        payload: {
          accountPayableId: randomUUID(),
          businessId: BUSINESS,
          amount: 150,
          serviceOrderId: null,
          registrationUserId: RECIPIENT,
        },
      },
    });

    ids.push(event.id);
  }

  return ids;
}

/** One e-mail row per (already expanded) event: the external lane's work. */
async function queueEmails(count: number): Promise<string[]> {
  const events = await publishEvents(count, "PUBLISHED");
  const ids: string[] = [];

  for (const outboxEventId of events) {
    const row = await prisma.notificationDelivery.create({
      data: {
        outboxEventId,
        userId: RECIPIENT,
        channel: "EMAIL",
        business_id: BUSINESS,
      },
    });

    ids.push(row.id);
  }

  return ids;
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Pool Contínuo",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444001358",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `pool-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: RECIPIENT,
      name: "Pessoa do Pool",
      email: `pool-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  const { app } = await import("@/http");
  await app.ready();

  container.registerInstance("MailProvider", {
    sendMail: async (message: { referenceId?: string }) => {
      const id = String(message.referenceId);

      if (id === mail.heldId && mail.hold) await mail.hold;

      mail.sent.push(id);

      return { messageId: `<${randomUUID()}@x>` };
    },
  });
}, 120_000);

beforeEach(async () => {
  mail.sent = [];
  mail.hold = null;
  mail.heldId = null;

  vi.restoreAllMocks();

  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
});

afterAll(async () => {
  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.$disconnect();
}, 60_000);

describe("one slow delivery in the external lane", () => {
  it(
    "holds its own slot and nothing else: the rest go out while it is held",
    { timeout: 60_000 },
    async () => {
      const ids = await queueEmails(30);
      const slow = ids[0];

      // The oldest due row by far: the first claim takes it.
      await prisma.notificationDelivery.update({
        where: { id: slow },
        data: { availableAt: new Date(Date.now() - 60 * 60_000) },
      });

      let open!: () => void;
      mail.heldId = slow;
      mail.hold = new Promise<void>((resolve) => (open = resolve));

      const cycle = (await newPipeline()).runDeliveryCycle("external");

      try {
        // Well under the 15 s backstop that ended the barrier's wait: with
        // it, the ten rows past the first batch could not go before then.
        await vi.waitFor(() => expect(mail.sent).toHaveLength(29), {
          timeout: 10_000,
          interval: 50,
        });

        expect(mail.sent).not.toContain(slow);
      } finally {
        open();
        await cycle;
      }

      expect(mail.sent.sort()).toEqual([...ids].sort());

      const settled = await prisma.notificationDelivery.findMany();

      expect(
        settled.filter(
          (row) => row.status !== "DELIVERED" || row.attempts !== 1,
        ),
      ).toEqual([]);
    },
  );
});

describe("a stop while the outbox expands", () => {
  it(
    "hands back the events claimed and not started, at once, and lets the one in flight finish",
    { timeout: 60_000 },
    async () => {
      const ids = await publishEvents(6);
      const pipeline = await newPipeline();

      const internals = pipeline as unknown as {
        expandEvent: (event: { id: string }) => Promise<void>;
      };
      const original = internals.expandEvent.bind(pipeline);

      let open!: () => void;
      const held = new Promise<void>((resolve) => (open = resolve));
      let first: string | null = null;
      let started!: () => void;
      const firstStarted = new Promise<void>((resolve) => (started = resolve));

      // One expansion at a time (OUTBOX_EXPANSION_CONCURRENCY=1): the first
      // one is held, the other five wait in the pool under the claim.
      vi.spyOn(internals, "expandEvent").mockImplementation(async (event) => {
        if (first === null) {
          first = event.id;
          started();
          await held;
        }

        await original(event);
      });

      const cycle = pipeline.runOutboxCycle();

      await firstStarted;

      const stopped = pipeline.shutdown();

      try {
        // Back before the one in flight ends: not after a 60 s lease.
        await vi.waitFor(
          async () => {
            const back = await prisma.domainOutboxEvent.findMany({
              where: { id: { not: first! }, status: "PENDING" },
            });

            expect(back).toHaveLength(5);
          },
          { timeout: 10_000, interval: 50 },
        );
      } finally {
        open();
      }

      await stopped;
      await cycle;

      const events = await prisma.domainOutboxEvent.findMany();
      const now = Date.now();

      for (const event of events) {
        if (event.id === first) {
          expect(`${event.status}:${event.attempts}`).toBe("PUBLISHED:1");
        } else {
          // The claim undone: no attempt spent, nothing waiting on a lease.
          expect(`${event.status}:${event.attempts}`, event.id).toBe(
            "PENDING:0",
          );
          expect(event.leaseExpiresAt).toBeNull();
          expect(event.availableAt.getTime()).toBeLessThanOrEqual(now);
        }
      }

      // The next replica expands each of them, once.
      await (await newPipeline()).runOutboxCycle();

      const after = await prisma.domainOutboxEvent.findMany({
        where: { id: { in: ids } },
      });

      expect(
        after
          .filter(
            (event) => event.status !== "PUBLISHED" || event.attempts !== 1,
          )
          .map((event) => `${event.id}:${event.status}:${event.attempts}`),
      ).toEqual([]);
    },
  );
});
