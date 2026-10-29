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
 * The outbox's claim covers a BATCH of events under one lease, and the
 * events are expanded one after the other. With the pool saturated, the
 * eighth expansion could start after the lease ran out — by then another
 * replica had reclaimed that event, and both expanded it: the work twice, an
 * attempt burned, and the contact upsert racing itself (OUTBOX-21).
 *
 * Before each expansion the worker now renews that event's lease, fenced by
 * the attempt it claimed. An event another replica took over fails the
 * renewal and is left to its new owner.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const BUSINESS = "018fc000-0000-7000-8000-000000000ee1";
const RECIPIENT = "018fc000-0000-7000-8000-000000000ee2";

async function publish(): Promise<string> {
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

  return event.id;
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Lease",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444000943",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `lease-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: RECIPIENT,
      name: "Pessoa do Lease",
      email: `lease-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();

  container.registerInstance("MailProvider", {
    sendMail: async () => ({ messageId: "<m@x>" }),
  });

  pipeline = (
    await import("@/shared/notifications/notification-pipeline-service")
  ).NotificationPipelineService.getInstance();
}, 120_000);

beforeEach(async () => {
  await prisma.domainOutboxEvent.deleteMany({
    where: { businessId: BUSINESS },
  });
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.domainOutboxEvent.deleteMany({
    where: { businessId: BUSINESS },
  });
  await prisma.notification.deleteMany({ where: { userId: RECIPIENT } });
  await prisma.activity.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.user.deleteMany({ where: { id: RECIPIENT } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a batch whose tail another replica reclaimed", () => {
  it("leaves the reclaimed event to its new owner", async () => {
    const first = await publish();
    const second = await publish();

    // Private on purpose; spied here to act as the other replica at the exact
    // moment this one finished the first expansion of its batch.
    const internals = pipeline as unknown as {
      expandEvent: (event: { id: string }) => Promise<void>;
    };

    const original = internals.expandEvent.bind(pipeline);
    const expanded: string[] = [];

    // Whichever of the two the batch expands first, the OTHER one is the
    // tail the other replica takes (the claim's RETURNING has no order).
    let tail: string | null = null;

    vi.spyOn(internals, "expandEvent").mockImplementation(async (event) => {
      expanded.push(event.id);

      await original(event);

      if (tail === null) {
        tail = event.id === first ? second : first;

        // The other replica: the lease "ran out", it claimed the tail
        // (attempts + 1, a fresh lease of its own).
        await prisma.$executeRaw`
          UPDATE "domain_outbox_event"
          SET "attempts" = "attempts" + 1,
              "leaseExpiresAt" = now() + interval '60 seconds'
          WHERE "id" = ${tail}
        `;
      }
    });

    await pipeline.runOutboxCycle();

    expect(tail).not.toBeNull();
    expect(expanded).toHaveLength(1);
    expect(expanded).not.toContain(tail);

    const reclaimed = await prisma.domainOutboxEvent.findUniqueOrThrow({
      where: { id: tail! },
    });

    // Still the other replica's: PROCESSING under its claim, untouched.
    expect(reclaimed.status).toBe("PROCESSING");
    expect(reclaimed.attempts).toBe(2);
  });

  it("still expands every event of a batch nobody else touched", async () => {
    const ids = [await publish(), await publish(), await publish()];

    await pipeline.runOutboxCycle();

    const events = await prisma.domainOutboxEvent.findMany({
      where: { id: { in: ids } },
    });

    expect(events.map((event) => event.status)).toEqual([
      "PUBLISHED",
      "PUBLISHED",
      "PUBLISHED",
    ]);
  });
});
