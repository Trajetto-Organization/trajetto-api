import "@/shared";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { container } from "tsyringe";
import type { z } from "zod";

import { GetDeliveryUseCase } from "@/modules/delivery/usecases/get-delivery/get-delivery-usecase";
import { ListMyDeliveriesUseCase } from "@/modules/delivery/usecases/list-my-deliveries/list-my-deliveries-usecase";

import { deliveryResponses } from "@/routes/documentation/delivery-documentation";
import { documentedDocFor } from "@/routes/documentation/doc-only-responses";

import { strictIssues } from "../unitaires/contract/support/deep-strict";

/**
 * The driver's day and the delivery detail, as documented, against what the
 * use cases really return from a real database.
 *
 * Both bodies go out through a pass-through schema — a strict one would strip
 * whatever the app reads and the schema forgot — so nothing at runtime notices
 * when the document drifts. This does: every key the payload carries must be
 * in the document, and every field the document requires must be in the
 * payload. A column added to Delivery, or an include added to the detail,
 * fails here until /docs says so.
 */
const prisma = new PrismaClient();

const CARRIER = "018f3000-0000-7000-8000-0000000005d0";
const OPERATOR = "018f3000-0000-7000-8000-0000000005d1";
const DRIVER_USER = "018f3000-0000-7000-8000-0000000005d2";
const DRIVER = "018f3000-0000-7000-8000-0000000005d3";
const SHIPPER = "018f3000-0000-7000-8000-0000000005d4";
const REASON = "018f3000-0000-7000-8000-0000000005d5";
const OCCURRENCE_TYPE = "018f3000-0000-7000-8000-0000000005d6";

let deliveryId = "";

function documented(runtime: z.ZodTypeAny): z.ZodTypeAny {
  const doc = documentedDocFor(runtime);

  if (!doc) throw new Error("schema sem documentação registrada");

  return doc;
}

/** What JSON.stringify makes of it — the wire, not the object. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora Documentada",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "11222333000555",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "documentada@exemplo.com.br",
    },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-doc",
      cpf: "cpf-doc",
      rg: "rg-doc",
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

  await prisma.user.createMany({
    data: [
      {
        id: OPERATOR,
        name: "Operadora",
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
        driverId: DRIVER,
      },
    ],
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await prisma.statusChangeReason.create({
    data: { id: REASON, name: "Cliente recusou", businessId: CARRIER },
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
      items: {
        create: [
          { description: "Caixa", quantity: 2, unit: "UN", unit_value: 10.5 },
        ],
      },
    },
  });

  deliveryId = delivery.id;

  const route = await prisma.route.create({
    data: {
      code: 1,
      scheduled_date: new Date(),
      status: "IN_PROGRESS",
      businessId: CARRIER,
      driverId: DRIVER,
      // The plan the app prints under each route (DLVP-ROUTE-1).
      destination: "CD Guarulhos",
      planned_departure_at: new Date("2026-09-17T11:00:00.000Z"),
      planned_arrival_at: new Date("2026-09-17T21:00:00.000Z"),
    },
  });

  await prisma.routeStop.create({
    data: {
      sequence: 10,
      routeId: route.id,
      deliveryId,
      // Arrival registered on another phone: the app reads it from here.
      status: "ARRIVED",
      arrived_at: new Date("2026-09-17T14:05:00.000Z"),
      // "A caminho" marked before the arrival (decision 6.4): the app restores
      // the mark from here after a reinstall or on another phone.
      on_the_way_at: new Date("2026-09-17T13:50:00.000Z"),
    },
  });

  await prisma.deliveryEvent.create({
    data: {
      type: "ARRIVAL",
      deliveryId,
      businessId: CARRIER,
      reportedById: DRIVER_USER,
      actor: "DRIVER_APP",
      device: "Moto G84",
      latitude: -23.55,
      longitude: -46.63,
      photo: `deliveryPhotos/${CARRIER}/chegada.jpg`,
      client_submission_id: randomUUID(),
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
      status_to: "IN_TRANSIT",
      reasonId: REASON,
      note: "Conferido por telefone.",
    },
  });

  await prisma.deliveryOccurrence.create({
    data: {
      deliveryId,
      businessId: CARRIER,
      occurrenceTypeId: OCCURRENCE_TYPE,
      reportedById: DRIVER_USER,
      description: "Ninguém atendeu",
      photos: [`deliveryPhotos/${CARRIER}/portao.jpg`],
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
    },
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the delivery bodies, as documented", () => {
  it("describes the driver's day exactly as the app receives it", async () => {
    const {
      deliveries,
      routes,
      occurrenceTypes,
      deliveredTypes,
      pauseTypes,
      journey,
    } = await container
      .resolve(ListMyDeliveriesUseCase)
      .execute({ userId: DRIVER_USER, businessId: CARRIER });

    // The controller's own envelope (decisions 14.3, 14.4 and 14.7 add keys).
    const body = wire({
      data: deliveries,
      routes,
      occurrence_types: occurrenceTypes,
      delivered_types: deliveredTypes,
      pause_types: pauseTypes,
      journey,
    }) as {
      data: Array<{ stops: unknown[]; items: unknown[] }>;
    };

    // Vacuous-pass guard: the fixture must reach every nested shape.
    expect(body.data).toHaveLength(1);
    expect(body.data[0].stops).toHaveLength(1);
    expect(body.data[0].items).toHaveLength(1);
    expect(routes).toHaveLength(1);

    expect(
      strictIssues(documented(deliveryResponses.myDeliveries), body),
    ).toEqual([]);
  });

  /**
   * What the app shows under each route section and on an arrived stop
   * (DLVP-ROUTE-1, MOB-11): the route's destination and planned times, and
   * when the driver marked "a caminho" (decision 6.4) and arrived. The stop
   * and route selects left them out, so an arrival or a mark made on another
   * phone (or before the cache) read as never made.
   */
  it("carries the stop's arrival, its 'a caminho' mark and the route's plan to the driver's day", async () => {
    const { deliveries } = await container
      .resolve(ListMyDeliveriesUseCase)
      .execute({ userId: DRIVER_USER, businessId: CARRIER });

    const [stop] = (
      wire(deliveries) as Array<{ stops: Array<Record<string, unknown>> }>
    )[0].stops;

    expect(stop.arrived_at).toBe("2026-09-17T14:05:00.000Z");
    expect(stop.on_the_way_at).toBe("2026-09-17T13:50:00.000Z");
    expect(stop.route).toMatchObject({
      destination: "CD Guarulhos",
      planned_departure_at: "2026-09-17T11:00:00.000Z",
      planned_arrival_at: "2026-09-17T21:00:00.000Z",
    });
  });

  it("describes the detail exactly as the panel receives it", async () => {
    const detail = await container.resolve(GetDeliveryUseCase).execute({
      userId: OPERATOR,
      businessId: CARRIER,
      deliveryId,
    });

    const body = wire({ data: detail }) as {
      data: Record<string, unknown[]>;
    };

    for (const nested of [
      "items",
      "events",
      "occurrences",
      "chatMessages",
      "timeline",
    ]) {
      expect(body.data[nested]?.length, nested).toBeGreaterThan(0);
    }

    expect(
      strictIssues(documented(deliveryResponses.deliveryDetail), body),
    ).toEqual([]);
  });
});
