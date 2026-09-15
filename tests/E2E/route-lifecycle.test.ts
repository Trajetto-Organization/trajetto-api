import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { DeliveryAlreadyOnRouteError } from "@/modules/route/usecases/errors/route-errors";

/**
 * The route's writes, against a real Postgres.
 *
 * What is proven here cannot be proven against the in-memory fake, because it
 * is not application logic: the `where` clauses, the partial unique indexes,
 * and the fact that the departure and the load leaving are one commit. The
 * fake mirrors all of it carefully — and a mirror is worth exactly what the
 * hand that cut it was worth.
 *
 * Repository-level on purpose. The use cases above it are pure decisions over
 * data these methods return, and the unit suite covers them; what needs a real
 * database is the half that only a real database enforces.
 */
const prisma = new PrismaClient();
const repository = new RouteRepository(prisma);

const CARRIER = "biz-lifecycle";
const DRIVER = "drv-lifecycle";

let deliverySeq = 0;
let vehicleSeq = 0;

async function seedCarrier(): Promise<void> {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora Ciclo",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222333000181",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "ciclo@exemplo.com.br",
    },
  });

  await prisma.shipper.create({
    data: { id: "shp-lifecycle", name: "Embarcador", businessId: CARRIER },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-lifecycle",
      cpf: "cpf-lifecycle",
      rg: "rg-lifecycle",
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

  await prisma.fuelType.create({
    data: { id: "ft-lifecycle", description: "Diesel", businessId: CARRIER },
  });

}

/**
 * A fresh vehicle each time.
 *
 * R6 allows one IN_PROGRESS route per vehicle, and most tests here leave their
 * route running deliberately — sharing one vehicle would make the SECOND test
 * in the file fail on the invariant the FIRST one established. The test that
 * means to hit R6 takes the same vehicle twice, on purpose and visibly.
 */
async function seedVehicle(): Promise<string> {
  vehicleSeq += 1;

  const id = `veh-${vehicleSeq}`;

  await prisma.vehicle.create({
    data: {
      id,
      description: "Caminhão",
      license_plate: `AAA1A${String(vehicleSeq).padStart(2, "0")}`,
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `renavam-${vehicleSeq}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: CARRIER,
      fuelTypeId: "ft-lifecycle",
    },
  });

  return id;
}

async function seedDelivery(): Promise<string> {
  deliverySeq += 1;

  const id = `dlv-${deliverySeq}`;

  await prisma.delivery.create({
    data: {
      id,
      recipient_name: `Cliente ${deliverySeq}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER,
      shipperId: "shp-lifecycle",
    },
  });

  return id;
}

async function deliveryRow(id: string) {
  return prisma.delivery.findUniqueOrThrow({ where: { id } });
}

async function stopsOf(deliveryId: string) {
  return prisma.routeStop.findMany({
    where: { deliveryId },
    orderBy: { created_at: "asc" },
  });
}

/** Create → release → depart, which is how every route reaches the street. */
async function runningRoute(
  deliveryIds: string[],
  vehicleId?: string,
): Promise<string> {
  const route = await repository.createRoute({
    businessId: CARRIER,
    driverId: DRIVER,
    vehicleId: vehicleId ?? (await seedVehicle()),
    scheduled_date: new Date(),
    deliveryIds,
  });

  await repository.transitionRoute(route.id, CARRIER, {
    expectedStatus: "PLANNED",
    status: "RELEASED",
  });

  await repository.transitionRoute(route.id, CARRIER, {
    expectedStatus: "RELEASED",
    status: "IN_PROGRESS",
    started_at: new Date(),
  });

  return route.id;
}

beforeAll(async () => {
  await seedCarrier();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the departure", () => {
  it("puts the load on the street in the same commit as the route leaving", async () => {
    const first = await seedDelivery();
    const second = await seedDelivery();
    const vehicle = await seedVehicle();

    const route = await repository.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      vehicleId: vehicle,
      scheduled_date: new Date(),
      deliveryIds: [first, second],
    });

    // Planning designates; it does not dispatch.
    expect((await deliveryRow(first)).status).toBe("PENDING");
    expect((await deliveryRow(first)).driverId).toBe(DRIVER);

    await repository.transitionRoute(route.id, CARRIER, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });

    // Releasing hands the route to the driver. Still nothing on the road.
    expect((await deliveryRow(first)).status).toBe("PENDING");

    await repository.transitionRoute(route.id, CARRIER, {
      expectedStatus: "RELEASED",
      status: "IN_PROGRESS",
      started_at: new Date(),
    });

    // Without this the driver's next action is refused with
    // DELIVERY_NOT_IN_TRANSIT, and the route is a dead end for the app.
    expect((await deliveryRow(first)).status).toBe("IN_TRANSIT");
    expect((await deliveryRow(second)).status).toBe("IN_TRANSIT");
    expect((await deliveryRow(second)).vehicleId).toBe(vehicle);
  });

  it("refuses a second departure on a vehicle that is already out", async () => {
    // R6, as the partial unique index states it. Planning two routes on one
    // vehicle is fine — a dispatcher lays out the week. The truck is on one
    // road.
    const vehicle = await seedVehicle();

    await runningRoute([await seedDelivery()], vehicle);

    const delivery = await seedDelivery();

    const second = await repository.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      vehicleId: vehicle,
      scheduled_date: new Date(),
      deliveryIds: [delivery],
    });

    await repository.transitionRoute(second.id, CARRIER, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });

    await expect(
      repository.transitionRoute(second.id, CARRIER, {
        expectedStatus: "RELEASED",
        status: "IN_PROGRESS",
        started_at: new Date(),
      }),
    ).rejects.toThrow();

    // Refused means refused: the whole transaction rolled back, mirroring
    // included, so this load never reached the street either.
    const row = await prisma.route.findUniqueOrThrow({
      where: { id: second.id },
    });

    expect(row.status).toBe("RELEASED");
    expect((await deliveryRow(delivery)).status).toBe("PENDING");
  });
});

describe("working the route", () => {
  it("settles stop by stop and closes itself on the last one", async () => {
    const first = await seedDelivery();
    const second = await seedDelivery();

    const routeId = await runningRoute([first, second]);

    const arrived = await repository.settleStopForDelivery(first, CARRIER, {
      from: ["PENDING"],
      status: "ARRIVED",
      arrived_at: new Date(),
    });

    expect(arrived?.stop.status).toBe("ARRIVED");
    expect(arrived?.closedRoute).toBeNull();

    const proven = await repository.settleStopForDelivery(first, CARRIER, {
      from: ["PENDING", "ARRIVED"],
      status: "COMPLETED",
      completed_at: new Date(),
    });

    expect(proven?.stop.status).toBe("COMPLETED");

    // One address left, so the route keeps running.
    expect(proven?.closedRoute).toBeNull();

    // An insucesso resolves the stop too — it is a result, not an
    // interruption, and the route can end on it.
    const failed = await repository.settleStopForDelivery(second, CARRIER, {
      from: ["PENDING", "ARRIVED"],
      status: "FAILED",
      completed_at: new Date(),
    });

    expect(failed?.stop.status).toBe("FAILED");
    expect(failed?.closedRoute?.status).toBe("COMPLETED");
    expect(failed?.closedRoute?.completed_at).not.toBeNull();

    const row = await prisma.route.findUniqueOrThrow({ where: { id: routeId } });

    expect(row.status).toBe("COMPLETED");
  });

  it("proves a stop that was never marked as arrived", async () => {
    // Deliberate: a driver who worked a whole street with no signal reaches
    // the server as proofs with no arrivals in front of them.
    const delivery = await seedDelivery();
    await runningRoute([delivery]);

    const settled = await repository.settleStopForDelivery(delivery, CARRIER, {
      from: ["PENDING", "ARRIVED"],
      status: "COMPLETED",
      completed_at: new Date(),
    });

    expect(settled?.stop.status).toBe("COMPLETED");
    expect(settled?.stop.arrived_at).toBeNull();
  });

  it("answers null for a delivery that is not on a route", async () => {
    // Most deliveries in this product never were. This runs on every delivery
    // outcome, so it must not throw for them.
    const delivery = await seedDelivery();

    expect(
      await repository.settleStopForDelivery(delivery, CARRIER, {
        from: ["PENDING", "ARRIVED"],
        status: "COMPLETED",
        completed_at: new Date(),
      }),
    ).toBeNull();
  });
});

describe("cancelling a route that already left", () => {
  it("sends what never arrived back to the pool, and keeps what did", async () => {
    const delivered = await seedDelivery();
    const untouched = await seedDelivery();

    const routeId = await runningRoute([delivered, untouched]);

    await repository.settleStopForDelivery(delivered, CARRIER, {
      from: ["PENDING", "ARRIVED"],
      status: "COMPLETED",
      completed_at: new Date(),
    });

    await repository.transitionRoute(routeId, CARRIER, {
      expectedStatus: "IN_PROGRESS",
      status: "CANCELLED",
      cancellation_reason: "Caminhão quebrou",
    });

    // What was proven this morning was proven, whatever happened afterwards.
    const [provenStop] = await stopsOf(delivered);

    expect(provenStop.status).toBe("COMPLETED");
    expect((await deliveryRow(delivered)).driverId).toBe(DRIVER);

    // What never got visited goes back where it came from — status AND
    // ownership. A delivery left IN_TRANSIT under a driver who is not driving
    // sits on the app of somebody who cannot do anything about it.
    const [openStop] = await stopsOf(untouched);

    expect(openStop.status).toBe("CANCELLED");

    const row = await deliveryRow(untouched);

    expect(row.status).toBe("PENDING");
    expect(row.driverId).toBeNull();
    expect(row.vehicleId).toBeNull();
  });

  it("frees the returned delivery for another route", async () => {
    // The whole reason cancelling also cancels the open stops: otherwise the
    // partial unique index keeps the delivery reserved by a route that no
    // longer runs — invisibly, and forever.
    const delivery = await seedDelivery();
    const routeId = await runningRoute([delivery]);

    await repository.transitionRoute(routeId, CARRIER, {
      expectedStatus: "IN_PROGRESS",
      status: "CANCELLED",
      cancellation_reason: "Motorista passou mal",
    });

    const replacement = await repository.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      vehicleId: await seedVehicle(),
      scheduled_date: new Date(),
      deliveryIds: [delivery],
    });

    expect(replacement.stops).toHaveLength(1);
    expect(replacement.stops[0].status).toBe("PENDING");
  });
});

describe("one open stop per delivery", () => {
  it("refuses to promise the same delivery to two routes", async () => {
    // R1, in the only place it is enforced: the database. Both routes are
    // PLANNED here, so no status guard above would catch this — the index is
    // the whole defence, and without it a delivery could be worked twice.
    const delivery = await seedDelivery();

    await repository.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      scheduled_date: new Date(),
      deliveryIds: [delivery],
    });

    await expect(
      repository.createRoute({
        businessId: CARRIER,
        driverId: DRIVER,
        scheduled_date: new Date(),
        deliveryIds: [delivery],
      }),
    ).rejects.toBeInstanceOf(DeliveryAlreadyOnRouteError);

    expect(await stopsOf(delivery)).toHaveLength(1);
  });

  it("lets a failed attempt be re-delivered, and keeps the attempt", async () => {
    const delivery = await seedDelivery();
    const firstRoute = await runningRoute([delivery]);

    await repository.settleStopForDelivery(delivery, CARRIER, {
      from: ["PENDING", "ARRIVED"],
      status: "FAILED",
      completed_at: new Date(),
    });

    // The failed stop is closed, so the index no longer reserves the delivery.
    const secondRoute = await runningRoute([delivery]);

    await repository.settleStopForDelivery(delivery, CARRIER, {
      from: ["PENDING", "ARRIVED"],
      status: "COMPLETED",
      completed_at: new Date(),
    });

    const [attempt, success] = await stopsOf(delivery);

    // Two stops on two routes: yesterday's attempt and today's delivery. The
    // stop carries its own outcome precisely so this history survives.
    expect(attempt.routeId).toBe(firstRoute);
    expect(attempt.status).toBe("FAILED");

    expect(success.routeId).toBe(secondRoute);
    expect(success.status).toBe("COMPLETED");
  });
});
