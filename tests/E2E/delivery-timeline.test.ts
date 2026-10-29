import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { buildDeliveryTimeline } from "@/shared/delivery/delivery-timeline";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The support trail, from the database up.
 *
 * The merge itself is pure and covered in the unit suite. What only a real
 * Postgres can answer is whether the READ feeds it: the relation names, the
 * nested includes, and whether the reason a status was overridden actually
 * travels with the event. Every one of those fails at runtime and nowhere
 * else — a typo in an include is a screen that renders empty, not a compile
 * error.
 */
const prisma = createPrismaClient();
const deliveries = new DeliveryRepository(prisma);

const CARRIER = "018f3000-0000-7000-8000-00000000000a";
const OPERATOR = "018f3000-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018f3000-0000-7000-8000-0000000000a2";

const DRIVER = "018f3000-0000-7000-8000-0000000000d1";
const SHIPPER = "018f3000-0000-7000-8000-0000000000f1";

const REASON = "018f3000-0000-7000-8000-0000000000e1";
const OCCURRENCE_TYPE = "018f3000-0000-7000-8000-0000000000c1";

let deliveryId: string;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora Trilha",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "11222333000177",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "trilha@exemplo.com.br",
    },
  });

  await prisma.user.createMany({
    data: [
      {
        id: OPERATOR,
        name: "Operadora do SAC",
        email: `${OPERATOR}@exemplo.com.br`,
        password: "x",
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
      },
      {
        id: DRIVER_USER,
        name: "João",
        email: `${DRIVER_USER}@exemplo.com.br`,
        password: "x",
        role: "BUSINESS_USER",
        businessId: CARRIER,
      },
    ],
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-trilha",
      cpf: "cpf-trilha",
      rg: "rg-trilha",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await prisma.statusChangeReason.create({
    data: {
      id: REASON,
      name: "Cliente recusou a mercadoria",
      businessId: CARRIER,
    },
  });

  await prisma.occurrenceType.create({
    data: {
      id: OCCURRENCE_TYPE,
      name: "Cliente ausente",
      blocks_delivery: true,
      businessId: CARRIER,
    },
  });

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Destinatário",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER,
      shipperId: SHIPPER,
      driverId: DRIVER,
      status: "IN_TRANSIT",
    },
  });

  deliveryId = delivery.id;

  // One of each kind, spread over the morning so the ordering means something.
  await prisma.deliveryEvent.create({
    data: {
      type: "ARRIVAL",
      deliveryId,
      businessId: CARRIER,
      reportedById: DRIVER_USER,
      actor: "DRIVER_APP",
      device: "Moto G84 · 3f9a",
      latitude: -23.55,
      longitude: -46.63,
      client_submission_id: randomUUID(),
      created_at: new Date("2026-09-15T09:00:00Z"),
    },
  });

  await prisma.deliveryOccurrence.create({
    data: {
      deliveryId,
      businessId: CARRIER,
      occurrenceTypeId: OCCURRENCE_TYPE,
      reportedById: DRIVER_USER,
      description: "Ninguém atendeu",
      created_at: new Date("2026-09-15T10:00:00Z"),
    },
  });

  const thread = await prisma.chatThread.create({
    data: { businessId: CARRIER, driverId: DRIVER },
  });

  await prisma.chatMessage.create({
    data: {
      kind: "TEXT",
      body: "Passa lá de novo às 16h",
      threadId: thread.id,
      senderId: OPERATOR,
      deliveryId,
      created_at: new Date("2026-09-15T11:00:00Z"),
    },
  });

  await prisma.deliveryEvent.create({
    data: {
      type: "STATUS_CHANGE",
      deliveryId,
      businessId: CARRIER,
      reportedById: OPERATOR,
      actor: "USER",
      status_from: "IN_TRANSIT",
      status_to: "FAILED",
      reasonId: REASON,
      note: "Cliente ligou às 14h.",
      created_at: new Date("2026-09-15T12:00:00Z"),
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("what the detail read actually brings back", () => {
  it("carries the reason alongside the status event", async () => {
    // The include is the whole point: without it the timeline renders
    // "Status alterado" with no answer to the question support asked.
    const detail = (await deliveries.findDeliveryDetailById(deliveryId)) as {
      events: Array<{ type: string; reason: { name: string } | null }>;
    };

    const statusEvent = detail.events.find(
      (event) => event.type === "STATUS_CHANGE",
    );

    expect(statusEvent?.reason?.name).toBe("Cliente recusou a mercadoria");
  });

  it("carries the messages that named this delivery", async () => {
    // A typo in the relation name here is a screen that renders one section
    // short, silently.
    const detail = (await deliveries.findDeliveryDetailById(deliveryId)) as {
      chatMessages: Array<{ body: string | null; sender: { name: string } }>;
    };

    expect(detail.chatMessages).toHaveLength(1);
    expect(detail.chatMessages[0].body).toBe("Passa lá de novo às 16h");
    expect(detail.chatMessages[0].sender.name).toBe("Operadora do SAC");
  });

  it("does not carry a message about a different delivery", async () => {
    const other = await prisma.delivery.create({
      data: {
        recipient_name: "Outro destinatário",
        city: "São Paulo",
        uf: "SP",
        street: "Outra rua",
        businessId: CARRIER,
        shipperId: SHIPPER,
      },
    });

    const thread = await prisma.chatThread.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    await prisma.chatMessage.create({
      data: {
        kind: "TEXT",
        body: "Sobre outra entrega",
        threadId: thread.id,
        senderId: OPERATOR,
        deliveryId: other.id,
      },
    });

    const detail = (await deliveries.findDeliveryDetailById(deliveryId)) as {
      chatMessages: Array<{ body: string | null }>;
    };

    expect(detail.chatMessages.map((message) => message.body)).toEqual([
      "Passa lá de novo às 16h",
    ]);
  });
});

describe("the trail the operator reads", () => {
  it("merges all four sources, newest first", async () => {
    const detail = (await deliveries.findDeliveryDetailById(deliveryId)) as any;

    const timeline = buildDeliveryTimeline({
      events: detail.events,
      occurrences: detail.occurrences,
      messages: detail.chatMessages,
    });

    expect(timeline.map((entry) => entry.kind)).toEqual([
      "STATUS_CHANGE",
      "MESSAGE",
      "OCCURRENCE",
      "ARRIVAL",
    ]);
  });

  it("answers “por que essa está assim?” in the first line", async () => {
    // The whole feature, in one assertion: the newest entry says what changed
    // and why, without the operator opening anything else.
    const detail = (await deliveries.findDeliveryDetailById(deliveryId)) as any;

    const [newest] = buildDeliveryTimeline({
      events: detail.events,
      occurrences: detail.occurrences,
      messages: detail.chatMessages,
    });

    expect(newest.title).toContain("Em rota");
    expect(newest.title).toContain("Insucesso");
    expect(newest.title).toContain("Cliente recusou a mercadoria");

    expect(newest.detail).toBe("Cliente ligou às 14h.");
    expect(newest.author.name).toBe("Operadora do SAC");
  });

  it("keeps the phone that reported the arrival", async () => {
    const detail = (await deliveries.findDeliveryDetailById(deliveryId)) as any;

    const arrival = buildDeliveryTimeline({
      events: detail.events,
      occurrences: detail.occurrences,
      messages: detail.chatMessages,
    }).find((entry) => entry.kind === "ARRIVAL");

    expect(arrival?.author).toEqual({
      kind: "DRIVER_APP",
      name: "João",
      device: "Moto G84 · 3f9a",
    });
  });

  it("flags the occurrence that changed the outcome", async () => {
    const detail = (await deliveries.findDeliveryDetailById(deliveryId)) as any;

    const occurrence = buildDeliveryTimeline({
      events: detail.events,
      occurrences: detail.occurrences,
      messages: detail.chatMessages,
    }).find((entry) => entry.kind === "OCCURRENCE");

    expect(occurrence?.title).toBe("Cliente ausente");
    expect(occurrence?.blocking).toBe(true);
  });
});
