import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { AlertRoutesLeftOpenUseCase } from "@/modules/route/usecases/alert-routes-left-open/alert-routes-left-open-usecase";
import { OutboxService } from "@/shared/notifications/outbox-service";

/**
 * Plan of 02/11/2026, K11 (decision D26), over real HTTP and Postgres.
 *
 * The Rota 1 of 30/10 stayed "Em andamento" for days: the driver could not
 * leave on the next route (ROUTE_DRIVER_BUSY), nor the truck. "Encerrar com
 * pendências" closes it under the route's lock — open stops cancelled, their
 * deliveries back to Pendente with a timeline line, the route COMPLETED with
 * the reason, the driver's plan-changed push in the same commit — and the
 * driver leaves again. The hourly sweep warns the admins once per route,
 * even with two replicas running it at the same instant.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const COMPANY = randomUUID();
const OTHER = randomUUID();

let seed: FleetDriverSeed;
let other: FleetDriverSeed;
let shipperId = "";

let forgottenId = "";
let nextId = "";
const openDeliveries: string[] = [];
let doneDelivery = "";

function post(url: string, token: string, body: unknown = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: body as Record<string, unknown>,
  });
}

async function delivery(status: "IN_TRANSIT" | "DELIVERED" | "PENDING") {
  return (
    await prisma.delivery.create({
      data: {
        recipient_name: `Cliente ${randomUUID().slice(0, 6)}`,
        city: "São Paulo",
        uf: "SP",
        street: "Rua do Encerramento",
        businessId: COMPANY,
        shipperId,
        status,
        driverId: status === "PENDING" ? null : seed.driverId,
        vehicleId: status === "PENDING" ? null : seed.vehicleId,
        delivered_at: status === "DELIVERED" ? new Date() : null,
      },
    })
  ).id;
}

const closeUrl = (routeId: string, businessId = COMPANY) =>
  `/route/close-with-pending/${routeId}/business/${businessId}`;

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: COMPANY,
    cnpj: `${Date.now()}`.slice(-8).padStart(8, "4") + "000191",
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: `${Date.now() + 11}`.slice(-8).padStart(8, "5") + "000191",
  });

  shipperId = (
    await prisma.shipper.create({
      data: { businessId: COMPANY, name: "Embarcador do encerramento" },
    })
  ).id;

  // The forgotten route: left three days ago, two stops still open.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  forgottenId = (
    await prisma.route.create({
      data: {
        code: 1,
        status: "IN_PROGRESS",
        scheduled_date: new Date(
          `${threeDaysAgo.toISOString().slice(0, 10)}T00:00:00.000Z`,
        ),
        started_at: threeDaysAgo,
        released_at: threeDaysAgo,
        businessId: COMPANY,
        driverId: seed.driverId,
        vehicleId: seed.vehicleId,
      },
    })
  ).id;

  await prisma.vehicle.update({
    where: { id: seed.vehicleId },
    data: { status: "IN_ROUTE" },
  });

  openDeliveries.push(
    await delivery("IN_TRANSIT"),
    await delivery("IN_TRANSIT"),
  );
  doneDelivery = await delivery("DELIVERED");

  for (const [index, deliveryId] of [
    ...openDeliveries,
    doneDelivery,
  ].entries()) {
    await prisma.routeStop.create({
      data: {
        routeId: forgottenId,
        deliveryId,
        sequence: (index + 1) * 10,
        status: index === 1 ? "ARRIVED" : index === 2 ? "COMPLETED" : "PENDING",
      },
    });
  }

  // Today's route of the same driver, released and waiting for him.
  nextId = (
    await prisma.route.create({
      data: {
        code: 2,
        status: "RELEASED",
        scheduled_date: new Date(
          `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
        ),
        released_at: new Date(),
        businessId: COMPANY,
        driverId: seed.driverId,
        vehicleId: seed.vehicleId,
      },
    })
  ).id;

  await prisma.routeStop.create({
    data: {
      routeId: nextId,
      deliveryId: await delivery("PENDING"),
      sequence: 10,
      status: "PENDING",
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("Encerrar com pendências (K11)", () => {
  it("keeps the driver from leaving while the forgotten route runs", async () => {
    const response = await post(
      `/route/start-route/${nextId}/business/${COMPANY}`,
      seed.driverToken,
    );

    expect(response.statusCode, response.body).toBe(409);
  });

  it("refuses a driver token, another company and a company field in the body", async () => {
    expect(
      (
        await post(closeUrl(forgottenId), seed.driverToken, {
          reason: "x".repeat(5),
        })
      ).statusCode,
    ).toBe(403);

    // Another company's manager on this company's path: the tenant guard.
    expect(
      (
        await post(closeUrl(forgottenId), other.managerToken, {
          reason: "Esquecida",
        })
      ).statusCode,
    ).toBe(403);

    // This company's route on the other company's own path: absent there.
    const foreign = await post(
      closeUrl(forgottenId, OTHER),
      other.managerToken,
      { reason: "Esquecida" },
    );

    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe("DELIVERY_ROUTE_NOT_FOUND");

    const withCompany = await post(closeUrl(forgottenId), seed.managerToken, {
      reason: "Esquecida",
      businessId: OTHER,
    });

    expect(withCompany.statusCode).toBe(400);

    const blank = await post(closeUrl(forgottenId), seed.managerToken, {
      reason: " ",
    });

    expect(blank.statusCode).toBe(400);

    // Nothing above wrote anything.
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: forgottenId } }))
        .status,
    ).toBe("IN_PROGRESS");
  });

  it("closes it: open stops cancelled, deliveries back to Pendente with a line, route completed with the reason", async () => {
    const response = await post(closeUrl(forgottenId), seed.managerToken, {
      reason: "Motorista esqueceu a rota aberta",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      id: forgottenId,
      status: "COMPLETED",
      closure_reason: "Motorista esqueceu a rota aberta",
      cancelledStops: 2,
      planVersion: 1,
      unchanged: false,
    });

    const route = await prisma.route.findUniqueOrThrow({
      where: { id: forgottenId },
    });

    expect(route).toMatchObject({
      status: "COMPLETED",
      closure_reason: "Motorista esqueceu a rota aberta",
      plan_version: 1,
    });
    expect(route.completed_at).not.toBeNull();

    const stops = await prisma.routeStop.findMany({
      where: { routeId: forgottenId },
      orderBy: { sequence: "asc" },
    });

    expect(stops.map((stop) => stop.status)).toEqual([
      "CANCELLED",
      "CANCELLED",
      "COMPLETED",
    ]);

    const deliveries = await prisma.delivery.findMany({
      where: { id: { in: [...openDeliveries, doneDelivery] } },
    });
    const byId = Object.fromEntries(deliveries.map((row) => [row.id, row]));

    for (const id of openDeliveries) {
      expect(byId[id]).toMatchObject({
        status: "PENDING",
        driverId: null,
        vehicleId: null,
      });
    }

    expect(byId[doneDelivery]).toMatchObject({
      status: "DELIVERED",
      driverId: seed.driverId,
    });

    const lines = await prisma.deliveryEvent.findMany({
      where: { routeId: forgottenId, type: "ROUTE_REMOVED" },
    });

    expect(lines.map((line) => line.deliveryId).sort()).toEqual(
      [...openDeliveries].sort(),
    );
    expect(lines[0].note).toBe(
      "Rota 1 encerrada com pendências: Motorista esqueceu a rota aberta",
    );

    // The driver's push, committed with the close.
    const pushes = await prisma.domainOutboxEvent.findMany({
      where: { topic: "route.plan_changed", aggregateId: forgottenId },
    });

    expect(pushes.map((row) => row.eventKey)).toEqual([
      `route:${forgottenId}:plan:1`,
    ]);

    // The truck is back.
    expect(
      (
        await prisma.vehicle.findUniqueOrThrow({
          where: { id: seed.vehicleId },
        })
      ).status,
    ).toBe("ACTIVE");
  });

  it("answers a resend as unchanged, writing and announcing nothing", async () => {
    const response = await post(closeUrl(forgottenId), seed.managerToken, {
      reason: "Motorista esqueceu a rota aberta",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ unchanged: true });

    expect(
      await prisma.domainOutboxEvent.count({
        where: { topic: "route.plan_changed", aggregateId: forgottenId },
      }),
    ).toBe(1);
  });

  it("refuses a route that is not running with 409", async () => {
    const response = await post(closeUrl(nextId), seed.managerToken, {
      reason: "Não saiu",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("ROUTE_STATUS_CONFLICT");
  });

  it("lets the driver leave on the next route", async () => {
    const response = await post(
      `/route/start-route/${nextId}/business/${COMPANY}`,
      seed.driverToken,
    );

    expect(response.statusCode, response.body).toBe(200);
  });

  it("shows the reason on the route detail", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/route/get-route/${forgottenId}/business/${COMPANY}`,
      headers: { authorization: `Bearer ${seed.managerToken}` },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.closure_reason).toBe(
      "Motorista esqueceu a rota aberta",
    );
  });
});

describe("the hourly sweep of routes left open (K11)", () => {
  it("announces each route left open exactly once, with two replicas sweeping at the same instant", async () => {
    // Another forgotten route (the other company's, left two days ago) and
    // a route that left an hour ago: only the first is due.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const due = (
      await prisma.route.create({
        data: {
          code: 1,
          status: "IN_PROGRESS",
          scheduled_date: new Date(
            `${twoDaysAgo.toISOString().slice(0, 10)}T00:00:00.000Z`,
          ),
          started_at: twoDaysAgo,
          businessId: OTHER,
          driverId: other.driverId,
          vehicleId: other.vehicleId,
        },
      })
    ).id;

    // Each replica builds its own repository and outbox, as two processes
    // would: the claim lives entirely in the database.
    const replica = () =>
      new AlertRoutesLeftOpenUseCase(
        new RouteRepository(),
        new OutboxService(),
      );

    const [first, second] = await Promise.all([
      replica().execute(),
      replica().execute(),
    ]);

    // The route started by "lets the driver leave" (today's) is not due.
    expect([...first, ...second]).toEqual([due]);

    const notices = await prisma.domainOutboxEvent.findMany({
      where: { topic: "route.left_open" },
    });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      eventKey: `route.left_open:${due}`,
      businessId: OTHER,
    });
    expect(notices[0].payload).toMatchObject({
      routeId: due,
      code: 1,
      openDays: 2,
    });

    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: due } }))
        .left_open_alerted_at,
    ).not.toBeNull();

    // The next hour: the same route is never announced again.
    expect(await replica().execute()).toEqual([]);
    expect(
      await prisma.domainOutboxEvent.count({
        where: { topic: "route.left_open" },
      }),
    ).toBe(1);
  });
});
