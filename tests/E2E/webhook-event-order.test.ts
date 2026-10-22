import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { v7 as uuidV7 } from "uuid";

import {
  WebhookDispatchService,
  fanOutWebhookEvent,
} from "@/shared/integration/webhook-dispatch-service";
import { buildResendRow } from "@/shared/integration/webhook-resend";

/**
 * The order of events, as a receiver can reconstruct it.
 *
 * Delivery is concurrent and retried: `delivery.in_transit` answered with a
 * 503 comes back thirty seconds after `delivery.delivered` already arrived,
 * and an ERP that applies the last one it received moves a delivered order
 * back to "in transit". Nothing in the body said which fact came first —
 * `created_at` is a timestamp two events of one transaction share.
 *
 * `sequence` does: increasing (with gaps) in the order events were generated,
 * identical for every endpoint and every resend of one event.
 */
const prisma = new PrismaClient();

const CARRIER = "018f8000-0000-7000-8000-0000000000c3";

const dispatcher = new WebhookDispatchService(async () => ({ allowed: true }));

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Ordem",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222888000133",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "ordem@exemplo.com.br",
    },
  });
}, 90_000);

beforeEach(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
});

afterAll(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });
  await prisma.$disconnect();
});

async function seedEndpoint(name: string): Promise<string> {
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name,
      // Never reached: these tests look at what is queued and claimed.
      url: `https://${name}.exemplo.com.br/hook`,
      secret: "whsec_teste_da_ordem",
      topics: ["delivery.*"],
      businessId: CARRIER,
    },
  });

  return endpoint.id;
}

function sequenceOf(signedBody: string | null): unknown {
  return JSON.parse(signedBody ?? "{}").sequence;
}

describe("the sequence of an event", () => {
  it("is in the body, the same for every endpoint, and grows event after event", async () => {
    await seedEndpoint("erp");
    await seedEndpoint("bi");

    await fanOutWebhookEvent({
      topic: "delivery.in_transit",
      businessId: CARRIER,
      payload: { delivery_id: "d1" },
    });

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { delivery_id: "d1" },
    });

    const rows = await prisma.webhookDelivery.findMany({
      where: { businessId: CARRIER },
    });

    const inTransit = rows.filter((row) => row.topic === "delivery.in_transit");
    const delivered = rows.filter((row) => row.topic === "delivery.delivered");

    expect(inTransit).toHaveLength(2);
    expect(delivered).toHaveLength(2);

    const first = sequenceOf(inTransit[0].signed_body);

    expect(
      Number.isSafeInteger(first),
      `sequence ausente do corpo: ${String(first)}`,
    ).toBe(true);

    // One fact, one number, whichever endpoint receives it.
    expect(sequenceOf(inTransit[1].signed_body)).toBe(first);

    const second = sequenceOf(delivered[0].signed_body) as number;

    expect(sequenceOf(delivered[1].signed_body)).toBe(second);
    expect(second).toBeGreaterThan(first as number);
  });

  it("is kept by a manual resend", async () => {
    await seedEndpoint("erp");

    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { delivery_id: "d2" },
    });

    const original = await prisma.webhookDelivery.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    const resent = await prisma.webhookDelivery.create({
      data: buildResendRow(original),
    });

    expect(sequenceOf(resent.signed_body)).toBe(
      sequenceOf(original.signed_body),
    );
    expect(Number.isSafeInteger(sequenceOf(resent.signed_body))).toBe(true);
  });
});

describe("the claim, between rows that share a timestamp", () => {
  it("takes them in the order they were created", async () => {
    const endpointId = await seedEndpoint("erp");

    // Twelve rows of one transaction: `availableAt` defaults to now(), the
    // transaction's time, so they all tie. uuid v7 ids grow in creation
    // order; they are written here in the opposite physical order, so the
    // table's own order and the ids disagree.
    const ids = Array.from({ length: 12 }, () => uuidV7()).sort();

    await prisma.webhookDelivery.createMany({
      data: [...ids].reverse().map((id) => ({
        id,
        endpointId,
        businessId: CARRIER,
        topic: "delivery.delivered",
        payload: {},
        signed_body: "{}",
        signature: "",
      })),
    });

    const claimed = await (
      dispatcher as unknown as { claim(): Promise<Array<{ id: string }>> }
    ).claim();

    // At most ten of one endpoint per claim: the ten created first.
    expect(claimed.map((row) => row.id).sort()).toEqual(ids.slice(0, 10));
  });
});
