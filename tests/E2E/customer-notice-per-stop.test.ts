import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@/shared/database/database-client";
import { OutboxService } from "@/shared/notifications/outbox-service";
import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { ExternalRecipientRepository } from "@/modules/delivery/repositories/external-recipient-repository";
import { markSiblingStopsOnTheWay } from "@/shared/delivery/stop-group";
import {
  STOP_MERGE_WINDOW_MS,
  buildDeliveryCustomerPayload,
} from "@/shared/delivery/customer-notice";

import type { NotificationTopic } from "@/shared/notifications/notification-types";

/**
 * One customer message per STOP, not per NF-e (plan of 02/11/2026, B6;
 * decision D37), on the real database.
 *
 * A shop receiving three NF-e on one route used to get three "saiu", three
 * "a caminho" and three "entregue". The stops of one visit — same address,
 * same recipient — now share a group key, written with the stop; the four
 * moments publish into the group's outbox row: "saiu" and "a caminho" at
 * once, "entregue" and "insucesso" after a 90 s window that gathers the
 * siblings resolved meanwhile. Two transactions publishing the same group at
 * the same moment (two replicas) land in one row: the INSERT ... ON CONFLICT
 * serializes on it.
 */
const prisma = createPrismaClient();
const outbox = new OutboxService();

const BUSINESS = "018fd000-0000-7000-8000-00000000b6b1";
const SHIPPER = "018fd000-0000-7000-8000-00000000b6b2";
const DRIVER = "018fd000-0000-7000-8000-00000000b6b3";

const SHOP = {
  street: "Rua das Flores",
  address_number: "120",
  city: "Cuiabá",
  uf: "MT",
  recipient_name: "Mercado Bom Preço",
  recipient_document: "12345678000190",
  recipient_telephone: "65999990000",
};

let routeCode = 900;
let invoice = 1000;

async function seedDelivery(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  invoice += 1;

  const delivery = await prisma.delivery.create({
    data: {
      businessId: BUSINESS,
      shipperId: SHIPPER,
      invoice_number: String(invoice),
      status: "PENDING",
      ...SHOP,
      ...overrides,
    },
  });

  return delivery.id;
}

/** A route created by the repository, the way every caller creates one. */
async function createRoute(deliveryIds: string[]): Promise<string> {
  routeCode += 1;

  const route = await new RouteRepository(prisma as never).createRoute({
    businessId: BUSINESS,
    driverId: DRIVER,
    scheduled_date: new Date(),
    deliveryIds,
  } as never);

  return route.id;
}

async function keysOf(routeId: string): Promise<Map<string, string | null>> {
  const stops = await prisma.routeStop.findMany({
    where: { routeId },
    select: { deliveryId: true, stop_group_key: true },
  });

  return new Map(stops.map((stop) => [stop.deliveryId, stop.stop_group_key]));
}

async function publish(
  topic: NotificationTopic,
  deliveryId: string,
  eventKey?: string,
): Promise<void> {
  const delivery = await prisma.delivery.findUniqueOrThrow({
    where: { id: deliveryId },
  });

  await prisma.$transaction(async (tx) => {
    await outbox.publish(tx as never, {
      topic: topic as "delivery.delivered",
      aggregateType: "delivery",
      aggregateId: deliveryId,
      businessId: BUSINESS,
      eventKey,
      payload: buildDeliveryCustomerPayload(deliveryId, delivery as never),
    });
  });
}

async function eventsOf(topic: string, deliveryIds: string[]) {
  const rows = await prisma.domainOutboxEvent.findMany({
    where: { topic, businessId: BUSINESS },
    orderBy: { created_at: "asc" },
  });

  return rows.filter((row) => {
    const payload = row.payload as {
      deliveryId: string;
      deliveries?: Array<{ deliveryId: string }>;
    };

    const ids = [
      payload.deliveryId,
      ...(payload.deliveries ?? []).map((entry) => entry.deliveryId),
    ];

    return ids.some((id) => deliveryIds.includes(id));
  });
}

const listed = (row: { payload: unknown }) =>
  (
    (row.payload as { deliveries?: Array<{ deliveryId: string }> })
      .deliveries ?? []
  )
    .map((entry) => entry.deliveryId)
    .sort();

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora B6",
      cep: "78000000",
      city: "Cuiabá",
      uf: "MT",
      street: "Rua",
      address_number: "1",
      cnpj: "33222111000666",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "65999999999",
      email: `b6-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: BUSINESS },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista B6",
      birth_date: new Date("1990-01-01"),
      cnh: `${DRIVER}-cnh`,
      cpf: `${DRIVER}-cpf`,
      rg: `${DRIVER}-rg`,
      cep: "78000000",
      city: "Cuiabá",
      uf: "MT",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: BUSINESS,
    },
  });
}, 60_000);

afterAll(async () => {
  await prisma.domainOutboxEvent.deleteMany({
    where: { businessId: BUSINESS },
  });
  await prisma.externalRecipient.deleteMany({
    where: { businessId: BUSINESS },
  });
  await prisma.route.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.delivery.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.driver.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.shipper.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });
  await prisma.$disconnect();
}, 60_000);

describe("the stop's group key", () => {
  it("is written with the stops: same address and recipient share it, another recipient does not", async () => {
    const a = await seedDelivery();
    const b = await seedDelivery({ street: " RUA DAS FLORES " });
    const other = await seedDelivery({ recipient_document: "98765432000110" });
    const nobody = await seedDelivery({
      recipient_document: null,
      recipient_telephone: null,
    });

    const keys = await keysOf(await createRoute([a, b, other, nobody]));

    expect(keys.get(a)).toMatch(/^[0-9a-f]{40}$/);
    expect(keys.get(b)).toBe(keys.get(a));
    expect(keys.get(other)).not.toBe(keys.get(a));
    expect(keys.get(nobody)).toBeNull();
  });

  it("is written for the stops added later too, and follows an edited address", async () => {
    const a = await seedDelivery();
    const routeId = await createRoute([a]);

    const b = await seedDelivery();

    await new RouteRepository(prisma as never).addStops(routeId, BUSINESS, [b]);

    expect((await keysOf(routeId)).get(b)).toBe((await keysOf(routeId)).get(a));

    // K9: the address changed, so it is another visit now.
    await new DeliveryRepository(prisma as never).updateDelivery(b, {
      address_number: "999",
    } as never);

    expect((await keysOf(routeId)).get(b)).not.toBe(
      (await keysOf(routeId)).get(a),
    );
  });
});

describe("saiu para entrega", () => {
  it("goes once for the stop's three NF-e, apart from another recipient's", async () => {
    const ids = [
      await seedDelivery(),
      await seedDelivery(),
      await seedDelivery(),
    ];
    const other = await seedDelivery({ recipient_document: "11122233000144" });

    await createRoute([...ids, other]);

    const rows = await prisma.delivery.findMany({
      where: { id: { in: [...ids, other] } },
    });

    // The departure publishes each departed delivery in one transaction.
    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        await outbox.publish(tx as never, {
          topic: "delivery.dispatched",
          aggregateType: "delivery",
          aggregateId: row.id,
          businessId: BUSINESS,
          payload: buildDeliveryCustomerPayload(row.id, row as never),
        });
      }
    });

    const stopEvents = await eventsOf("delivery.dispatched", ids);

    expect(stopEvents).toHaveLength(1);
    expect(listed(stopEvents[0])).toEqual([...ids].sort());
    expect(stopEvents[0].availableAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 1000,
    );

    // A stop of its own publishes as before: no group, no list.
    const own = await eventsOf("delivery.dispatched", [other]);

    expect(own).toHaveLength(1);
    expect(own[0].payload).not.toHaveProperty("deliveries");
  });
});

describe("a caminho", () => {
  it("marks the stop's siblings and tells the customer once, whichever stop is tapped next", async () => {
    const [a, b] = [await seedDelivery(), await seedDelivery()];
    const routeId = await createRoute([a, b]);

    const stops = await prisma.routeStop.findMany({
      where: { routeId },
      orderBy: { sequence: "asc" },
    });

    const at = new Date();

    await prisma.$transaction(async (tx) => {
      await markSiblingStopsOnTheWay(tx as never, {
        routeId,
        stopId: stops[0].id,
        at,
      });
    });

    expect(
      (
        await prisma.routeStop.findUniqueOrThrow({ where: { id: stops[1].id } })
      ).on_the_way_at?.getTime(),
    ).toBe(at.getTime());

    await publish(
      "delivery.on_the_way",
      a,
      `delivery.on_the_way:${stops[0].id}`,
    );

    const first = await eventsOf("delivery.on_the_way", [a, b]);

    expect(first).toHaveLength(1);
    expect(listed(first[0])).toEqual([a, b].sort());

    // Once the pipeline took it, the sibling is not told again.
    await prisma.domainOutboxEvent.update({
      where: { id: first[0].id },
      data: { status: "PUBLISHED" },
    });

    await publish(
      "delivery.on_the_way",
      b,
      `delivery.on_the_way:${stops[1].id}`,
    );

    expect(await eventsOf("delivery.on_the_way", [a, b])).toHaveLength(1);
  });
});

describe("entregue", () => {
  it("waits 90 s and gathers the siblings proven in the window; one after it goes alone", async () => {
    const [a, b, c] = [
      await seedDelivery(),
      await seedDelivery(),
      await seedDelivery(),
    ];

    await createRoute([a, b, c]);

    const before = Date.now();

    await publish("delivery.delivered", a);
    await publish("delivery.delivered", b);

    const merged = await eventsOf("delivery.delivered", [a, b, c]);

    expect(merged).toHaveLength(1);
    expect(listed(merged[0])).toEqual([a, b].sort());
    expect(merged[0].availableAt.getTime()).toBeGreaterThanOrEqual(
      before + STOP_MERGE_WINDOW_MS - 1000,
    );

    // A replay of the same proof is the same delivery, listed again: the
    // render lists each delivery once.
    await publish("delivery.delivered", a);

    expect(await eventsOf("delivery.delivered", [a, b, c])).toHaveLength(1);

    // The window closed: the pipeline took the group's row.
    await prisma.domainOutboxEvent.update({
      where: { id: merged[0].id },
      data: { status: "PROCESSING" },
    });

    await publish("delivery.delivered", c);

    const after = await eventsOf("delivery.delivered", [a, b, c]);

    expect(after).toHaveLength(2);
    expect(listed(after[1])).toEqual([c]);
  });

  it("lands in one row when two replicas publish the same stop at the same moment", async () => {
    const [a, b] = [await seedDelivery(), await seedDelivery()];

    await createRoute([a, b]);

    await Promise.all([
      publish("delivery.failed", a),
      publish("delivery.failed", b),
    ]);

    const rows = await eventsOf("delivery.failed", [a, b]);

    expect(rows).toHaveLength(1);
    expect(listed(rows[0])).toEqual([a, b].sort());
  });
});

describe("the tracking page of a stop's message", () => {
  it("lists the visit's other NF-e", async () => {
    const [a, b] = [await seedDelivery(), await seedDelivery()];
    const other = await seedDelivery({ recipient_document: "55566677000188" });

    await createRoute([a, b, other]);

    const recipients = new ExternalRecipientRepository(prisma as never);

    const row = await recipients.ensureForDelivery({
      deliveryId: a,
      businessId: BUSINESS,
      name: SHOP.recipient_name,
      email: null,
      telephone: SHOP.recipient_telephone,
    });

    const source = await recipients.findByToken(row.access_token);

    const invoiceOf = await prisma.delivery.findUniqueOrThrow({
      where: { id: b },
    });

    expect(source?.sameStop?.map((sibling) => sibling.invoice_number)).toEqual([
      invoiceOf.invoice_number,
    ]);
  });
});
