import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";
import { deliveryIdFor } from "@/shared/notifications/delivery-id";

/**
 * The rules of `notification_delivery` that live only in raw SQL, and the
 * one that replaced two of them.
 *
 * Migration 20260916090000_external_recipient made `userId` nullable so a
 * delivery could address somebody with no account, and replaced the
 * `(outboxEventId, userId, channel)` unique key with two PARTIAL unique
 * indexes plus a CHECK that exactly one recipient column is set. Prisma has
 * no syntax for either, so schema.prisma cannot show them and no diff notices
 * when they go missing.
 *
 * They were not decoration: `expandEvent` writes deliveries with
 * `createMany({ skipDuplicates: true })`, and that is only idempotent while a
 * unique key backs it. Without one, an event expanded twice (lease ran out
 * while the first expansion was still writing) queues two WhatsApp rows for
 * the same customer — two messages, nothing failing. Since F5-06 (plano de
 * escala) the key is the primary key: the delivery's id is decided by the
 * event, the recipient and the channel, and the partial uniques are gone.
 *
 * Prisma 6.1's `migrate dev` does not offer to drop partial indexes or CHECKs
 * (its introspection skips them), so the realistic ways to lose these are a
 * hand-written migration, a DROP COLUMN that cascades, or a future Prisma that
 * starts modelling partial indexes. Each of those fails here first.
 */
const prisma = createPrismaClient();

const BUSINESS = "018fd000-0000-7000-8000-0000000008a1";

let userId = "";
let externalRecipientId = "";
let outboxEventId = "";

interface IndexRow {
  indexname: string;
  indexdef: string;
}

async function indexesOf(table: string): Promise<IndexRow[]> {
  return prisma.$queryRawUnsafe<IndexRow[]>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`,
    table,
  );
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora das Invariantes",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "55333444000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `invariantes-${randomUUID()}@exemplo.com.br`,
    },
  });

  userId = (
    await prisma.user.create({
      data: {
        name: "Pessoa Destinatária",
        email: `destinataria-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: BUSINESS,
      },
    })
  ).id;

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId: BUSINESS },
  });

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Padaria Central",
      code: `PED-${randomUUID().slice(0, 8)}`,
      city: "São Paulo",
      uf: "SP",
      street: "Praça da Sé",
      businessId: BUSINESS,
      shipperId: shipper.id,
    },
  });

  externalRecipientId = (
    await prisma.externalRecipient.create({
      data: {
        name: "Cliente Final",
        telephone: "5511988887777",
        access_token: randomUUID(),
        deliveryId: delivery.id,
        businessId: BUSINESS,
      },
    })
  ).id;

  outboxEventId = (
    await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `delivery.dispatched:${randomUUID()}`,
        topic: "delivery.dispatched",
        aggregateType: "delivery",
        aggregateId: delivery.id,
        businessId: BUSINESS,
        payload: { deliveryId: delivery.id, businessId: BUSINESS },
      },
    })
  ).id;
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Since F5-06 the re-expansion is a no-op by the delivery's own id: it is
 * decided by (event, recipient, channel) (deliveryIdFor, F5-03), so the
 * primary key does what the two partial unique indexes did, and the queue
 * can be partitioned by day on it (a partitioned table cannot hold those
 * uniques). Both indexes are gone; the promise is the same.
 */
describe("what makes a re-expansion a no-op", () => {
  it("is no longer a unique index: both partial ones left with F5-06", async () => {
    const names = (await indexesOf("notification_delivery")).map(
      (row) => row.indexname,
    );

    expect(names).not.toContain("notification_delivery_user_event_channel_idx");
    expect(names).not.toContain(
      "notification_delivery_external_event_channel_idx",
    );
  });

  async function event() {
    return prisma.domainOutboxEvent.findUniqueOrThrow({
      where: { id: outboxEventId },
      select: { id: true, created_at: true },
    });
  }

  it("turns a second expansion for a user into nothing, by the id", async () => {
    const recipient = { userId, externalRecipientId: null };
    const row = {
      id: deliveryIdFor(await event(), recipient, "EMAIL"),
      outboxEventId,
      userId,
      channel: "EMAIL" as const,
    };

    const first = await prisma.notificationDelivery.createMany({
      data: [row],
      skipDuplicates: true,
    });

    const second = await prisma.notificationDelivery.createMany({
      data: [{ ...row, id: deliveryIdFor(await event(), recipient, "EMAIL") }],
      skipDuplicates: true,
    });

    expect(first.count).toBe(1);
    expect(second.count).toBe(0);
  });

  it("turns a second expansion for a customer into nothing, not a second WhatsApp", async () => {
    const recipient = { userId: null, externalRecipientId };
    const row = () =>
      event().then((found) => ({
        id: deliveryIdFor(found, recipient, "WHATSAPP"),
        outboxEventId,
        externalRecipientId,
        channel: "WHATSAPP" as const,
      }));

    const first = await prisma.notificationDelivery.createMany({
      data: [await row()],
      skipDuplicates: true,
    });

    const second = await prisma.notificationDelivery.createMany({
      data: [await row()],
      skipDuplicates: true,
    });

    expect(first.count).toBe(1);
    expect(second.count).toBe(0);

    expect(
      await prisma.notificationDelivery.count({
        where: { outboxEventId, externalRecipientId, channel: "WHATSAPP" },
      }),
    ).toBe(1);
  });
});

describe("the rule that a delivery addresses exactly one recipient", () => {
  it("is a CHECK constraint on both columns", async () => {
    const rows = await prisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = 'notification_delivery_one_recipient' AND contype = 'c'
    `;

    expect(
      rows,
      "o CHECK notification_delivery_one_recipient sumiu — ver 20260916090000_external_recipient",
    ).toHaveLength(1);

    expect(rows[0].def).toContain('"userId"');
    expect(rows[0].def).toContain('"externalRecipientId"');
  });

  /**
   * A row with no recipient would have no id of its own to dedupe on (its
   * id is decided by the recipient) and sit in the queue forever, claimed
   * and failed on every cycle.
   */
  it("refuses a row with no recipient at all", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "notification_delivery"
          ("id", "outboxEventId", "channel", "updated_at")
        VALUES (${randomUUID()}, ${outboxEventId}, 'EMAIL', now())
      `,
    ).rejects.toSatisfy(violatesOneRecipient);
  });

  it("refuses a row that addresses a user and a customer at once", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "notification_delivery"
          ("id", "outboxEventId", "userId", "externalRecipientId", "channel", "updated_at")
        VALUES
          (${randomUUID()}, ${outboxEventId}, ${userId}, ${externalRecipientId}, 'EMAIL', now())
      `,
    ).rejects.toSatisfy(violatesOneRecipient);
  });

  it("accepts the same row once it names exactly one recipient", async () => {
    // The control for the two refusals above: without it, an insert that
    // failed for any other reason (a new NOT NULL column, a typo) would pass
    // them as a "check violation".
    await expect(
      prisma.$executeRaw`
        INSERT INTO "notification_delivery"
          ("id", "outboxEventId", "userId", "channel", "updated_at")
        VALUES (${randomUUID()}, ${outboxEventId}, ${userId}, 'PUSH', now())
      `,
    ).resolves.toBe(1);
  });
});

/**
 * SQLSTATE 23514 on this constraint by name — not merely "the insert
 * failed", which a NOT NULL column or a bad enum value would also produce.
 */
function violatesOneRecipient(error: unknown): boolean {
  const text =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? `${error.message} ${JSON.stringify(error.meta ?? {})}`
      : String(error);

  return (
    text.includes("notification_delivery_one_recipient") &&
    (text.includes("23514") || /check constraint/i.test(text))
  );
}
