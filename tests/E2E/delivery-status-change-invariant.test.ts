import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { OperationDayRepository } from "@/modules/route/repositories/operation-day-repository";
import { fanOutWebhookEvents } from "@/shared/integration/webhook-dispatch-service";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Every status a delivery ever had has its line (plano-escala F2-06).
 *
 * The departure was an updateMany that only said how many moved: the load
 * went "Em rota" with no line on its trail, and so did the route ending
 * that brought it back, the app's old batch departure, a stop added to a
 * running route and the creation itself. The trail's last status then
 * disagreed with the row, the integration feed never said
 * `delivery.in_transit`, and support read a history with holes.
 *
 * The invariant, as the owner checks it on staging: for every delivery,
 * the last line that carries a status — a STATUS_CHANGE (its status_to),
 * a PROOF (DELIVERED) or a blocking occurrence that took effect (FAILED) —
 * says the status the row has. Through the real repositories, against
 * Postgres: the RETURNING, the one insert per batch and the commit they
 * share are what is under test.
 */
const prisma = createPrismaClient();
const deliveries = new DeliveryRepository(prisma);
const routes = new RouteRepository(prisma);

const CARRIER = randomUUID();
const DRIVER = randomUUID();
const SHIPPER = randomUUID();

async function newDelivery(
  overrides: { driverId?: string; apiKeyId?: string } = {},
): Promise<string> {
  const created = await deliveries.createDelivery({
    recipient_name: "Cliente",
    city: "São Paulo",
    uf: "SP",
    street: "Rua das Entregas",
    businessId: CARRIER,
    shipperId: SHIPPER,
    ...overrides,
  });

  return created.id!;
}

async function trailOf(deliveryId: string) {
  return prisma.deliveryEvent.findMany({
    where: { deliveryId, type: "STATUS_CHANGE" },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
    select: {
      status_from: true,
      status_to: true,
      actor: true,
      routeId: true,
      apiKeyId: true,
    },
  });
}

/** The deliveries whose last status-bearing line disagrees with the row. */
async function strays(businessId: string) {
  return prisma.$queryRaw<
    Array<{ id: string; status: string; trail: string | null }>
  >`
    WITH last AS (
      SELECT DISTINCT ON (e."deliveryId")
             e."deliveryId",
             CASE e."type"
               WHEN 'STATUS_CHANGE' THEN e."status_to"::text
               WHEN 'PROOF' THEN 'DELIVERED'
               ELSE 'FAILED'
             END AS "status"
        FROM "delivery_event" e
        LEFT JOIN "delivery_occurrence" o ON o."id" = e."occurrenceId"
        LEFT JOIN "occurrence_type" t ON t."id" = o."occurrenceTypeId"
       WHERE e."businessId" = ${businessId}
         AND (
           e."type" IN ('STATUS_CHANGE', 'PROOF')
           OR (e."type" = 'OCCURRENCE' AND t."blocks_delivery"
               AND o."authorization_status" IN ('NOT_REQUIRED', 'APPROVED'))
         )
       -- One transaction is one instant: a redelivery onto a running route
       -- writes the dispatcher's line and the departure's. The SYSTEM line is
       -- the consequence, so it is the later of the two.
       ORDER BY e."deliveryId", e."created_at" DESC,
                (e."actor" = 'SYSTEM') DESC, e."id" DESC
    )
    SELECT d."id", d."status"::text AS "status", l."status" AS "trail"
      FROM "delivery" d
      LEFT JOIN last l ON l."deliveryId" = d."id"
     WHERE d."businessId" = ${businessId}
       AND l."status" IS DISTINCT FROM d."status"::text
  `;
}

async function runningRoute(deliveryIds: string[]): Promise<string> {
  const route = await routes.createRoute({
    businessId: CARRIER,
    driverId: DRIVER,
    scheduled_date: new Date(),
    deliveryIds,
  });

  await routes.transitionRoute(route.id, CARRIER, {
    expectedStatus: "PLANNED",
    status: "RELEASED",
  });
  await routes.transitionRoute(route.id, CARRIER, {
    expectedStatus: "RELEASED",
    status: "IN_PROGRESS",
    started_at: new Date(),
  });

  return route.id;
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: `Transportadora Trilha ${CARRIER.slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "11222333000181",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `trilha-${CARRIER}@exemplo.com.br`,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
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
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the lines a delivery gets by itself", () => {
  it("starts with its creation, by the panel or by the key that made it", async () => {
    const panel = await newDelivery();

    expect(await trailOf(panel)).toEqual([
      {
        status_from: null,
        status_to: "PENDING",
        actor: "USER",
        routeId: null,
        apiKeyId: null,
      },
    ]);
  });

  it("goes out with the route and comes back when the route is cancelled", async () => {
    const first = await newDelivery();
    const second = await newDelivery();
    const routeId = await runningRoute([first, second]);

    expect((await trailOf(first)).slice(1)).toEqual([
      {
        status_from: "PENDING",
        status_to: "IN_TRANSIT",
        actor: "SYSTEM",
        routeId,
        apiKeyId: null,
      },
    ]);

    await routes.transitionRoute(routeId, CARRIER, {
      expectedStatus: "IN_PROGRESS",
      status: "CANCELLED",
      cancellation_reason: "Caminhão quebrou",
    });

    expect((await trailOf(second)).slice(2)).toEqual([
      {
        status_from: "IN_TRANSIT",
        status_to: "PENDING",
        actor: "SYSTEM",
        routeId,
        apiKeyId: null,
      },
    ]);
  });

  it("leaves with a stop added to a running route", async () => {
    const routeId = await runningRoute([await newDelivery()]);
    const late = await newDelivery();

    await routes.addStops(routeId, CARRIER, [late]);

    expect((await trailOf(late)).slice(1)).toEqual([
      expect.objectContaining({
        status_from: "PENDING",
        status_to: "IN_TRANSIT",
        actor: "SYSTEM",
        routeId,
      }),
    ]);
  });

  it("leaves with the app's old batch departure, each one handed to its webhooks", async () => {
    const loose = [
      await newDelivery({ driverId: DRIVER }),
      await newDelivery({ driverId: DRIVER }),
    ];
    // On a route: it leaves with the route, never with the batch.
    const routed = await newDelivery({ driverId: DRIVER });

    await routes.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      scheduled_date: new Date(),
      deliveryIds: [routed],
    });

    const handed: string[] = [];
    const moved = await deliveries.startDriverRoute(
      CARRIER,
      DRIVER,
      undefined,
      async (departed) => {
        handed.push(...departed.map((delivery) => delivery.id));
      },
    );

    expect(moved).toBe(2);
    expect(handed.sort()).toEqual([...loose].sort());

    for (const id of loose) {
      expect((await trailOf(id)).slice(1)).toEqual([
        expect.objectContaining({
          status_from: "PENDING",
          status_to: "IN_TRANSIT",
          actor: "SYSTEM",
          routeId: null,
        }),
      ]);
    }

    expect(await trailOf(routed)).toHaveLength(1);
  });
});

describe("the invariant", () => {
  it("holds for every delivery of the company: the last line says its status", async () => {
    // A proof, so the check reads more than STATUS_CHANGE lines.
    const proven = await newDelivery();

    await runningRoute([proven]);
    await deliveries.registerDeliveryProof(
      { type: "PROOF", deliveryId: proven, received_by: "Maria" } as never,
      "IN_TRANSIT",
    );

    // "Reentregar" onto a running route: the dispatcher's FAILED → PENDING
    // and the departure's PENDING → IN_TRANSIT in one commit, one instant.
    const failed = await newDelivery();

    await prisma.$transaction(async (tx) => {
      await deliveries.updateDeliveryStatus(
        failed,
        { status: "FAILED", expectedStatus: "PENDING" },
        tx,
      );
      await deliveries.createDeliveryEvent(
        {
          type: "STATUS_CHANGE",
          deliveryId: failed,
          status_from: "PENDING",
          status_to: "FAILED",
        },
        tx,
      );
    });

    const running = await runningRoute([await newDelivery()]);

    await prisma.$transaction(async (tx) => {
      await deliveries.updateDeliveryStatus(
        failed,
        { status: "PENDING", expectedStatus: "FAILED" },
        tx,
      );
      await deliveries.createDeliveryEvent(
        {
          type: "STATUS_CHANGE",
          deliveryId: failed,
          status_from: "FAILED",
          status_to: "PENDING",
        },
        tx,
      );
      await routes.addStops(running, CARRIER, [failed], tx);
    });

    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: failed } }))
        .status,
    ).toBe("IN_TRANSIT");

    expect(await strays(CARRIER)).toEqual([]);

    // And it notices a status moved with no line.
    await prisma.delivery.update({
      where: { id: proven },
      data: { status: "FAILED" },
    });

    expect(await strays(CARRIER)).toEqual([
      { id: proven, status: "FAILED", trail: "DELIVERED" },
    ]);

    await prisma.delivery.update({
      where: { id: proven },
      data: { status: "DELIVERED" },
    });
  });
});

describe("the control tower's feed", () => {
  it("leaves out the lines the delivery got by itself; the route has its own", async () => {
    await runningRoute([await newDelivery()]);

    const now = Date.now();
    const feed = await new OperationDayRepository(prisma).listFeed(
      CARRIER,
      {
        date: new Date(now).toISOString().slice(0, 10),
        start: new Date(now - 86_400_000),
        end: new Date(now + 86_400_000),
        isToday: true,
      },
      200,
    );

    // Only the lines a person wrote: the redelivery's two, above.
    const byPeople = await prisma.deliveryEvent.findMany({
      where: {
        businessId: CARRIER,
        type: "STATUS_CHANGE",
        actor: { not: "SYSTEM" },
        NOT: { status_from: null, status_to: "PENDING" },
      },
      select: { id: true },
    });

    expect(byPeople).toHaveLength(2);
    expect(
      feed
        .filter((entry) => entry.type === "STATUS_CHANGE")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(byPeople.map((row) => `delivery_event:${row.id}`).sort());
    expect(feed.some((entry) => entry.type === "ROUTE_STARTED")).toBe(true);
  });
});

describe("what a departure costs", () => {
  const capture = createPrismaClient({
    log: [{ emit: "event", level: "query" }],
  });
  const sent: string[] = [];

  capture.$on("query", (event) => {
    sent.push(event.query);
  });

  afterAll(async () => {
    await capture.$disconnect();
  });

  async function statementsOfDeparture(stops: number): Promise<number> {
    const ids: string[] = [];

    for (let i = 0; i < stops; i += 1) ids.push(await newDelivery());

    const route = await routes.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      scheduled_date: new Date(),
      deliveryIds: ids,
    });

    await routes.transitionRoute(route.id, CARRIER, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });

    sent.length = 0;

    await new RouteRepository(capture).transitionRoute(route.id, CARRIER, {
      expectedStatus: "RELEASED",
      status: "IN_PROGRESS",
      started_at: new Date(),
    });

    return sent.length;
  }

  // The plan's budget: the departure of 50 stops pays two statements more
  // than before, whatever the number of stops — the UPDATE that returns the
  // rows replaces the updateMany, and the lines are one insert. The second
  // is the webhooks' read of the endpoints, below.
  it("does not grow with the stops: 50 cost what 1 costs", async () => {
    const one = await statementsOfDeparture(1);
    const fifty = await statementsOfDeparture(50);

    expect(fifty).toBe(one);
  });

  it("tells the customers' systems in one read when nobody listens, three when someone does", async () => {
    const payloads = Array.from({ length: 50 }, (_, index) => ({
      topic: "delivery.in_transit",
      businessId: CARRIER,
      payload: { delivery_id: `d-${index}` },
    }));

    const quiet = await capture.$transaction(async (tx) => {
      sent.length = 0;
      await fanOutWebhookEvents(payloads, tx);

      return sent.length;
    });

    expect(quiet).toBe(1);

    await prisma.webhookEndpoint.create({
      data: {
        name: "ERP",
        url: "https://erp.example.com/hook",
        secret: "sealed",
        topics: ["delivery.in_transit"],
        businessId: CARRIER,
      },
    });

    const listened = await capture.$transaction(async (tx) => {
      sent.length = 0;
      await fanOutWebhookEvents(payloads, tx);

      return sent.length;
    });

    expect(listened).toBe(3);

    const rows = await prisma.webhookDelivery.findMany({
      where: { businessId: CARRIER },
      select: { sourceEventId: true, signed_body: true },
    });
    const sequences = rows.map(
      (row) => (JSON.parse(row.signed_body!) as { sequence: number }).sequence,
    );

    // One row per event, each its own id and sequence.
    expect(rows).toHaveLength(50);
    expect(new Set(rows.map((row) => row.sourceEventId)).size).toBe(50);
    expect(new Set(sequences).size).toBe(50);
  });
});
