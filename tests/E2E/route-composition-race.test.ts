import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RouteRepository } from "@/modules/route/repositories/route-repository";
import {
  DeliveryNoLongerRoutableError,
  RouteStatusConflictError,
} from "@/modules/route/usecases/errors/route-errors";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Composing a route while it departs (IDEMP-06).
 *
 * Every composition write (add, remove, reorder, detach) used to read the
 * route's status with a plain SELECT and then write. The departure is an
 * UPDATE, which takes FOR NO KEY UPDATE on the route row, and the INSERT of a
 * stop only takes FOR KEY SHARE through the foreign key: the two modes do not
 * conflict, so both transactions ran side by side under READ COMMITTED and
 * each committed a decision made on a snapshot the other had already changed.
 *
 * The departure is held open on purpose here, with its row lock, and the
 * composition runs inside that window. The interleaving is forced, not hoped
 * for: nothing in these tests depends on timing luck.
 */
const prisma = createPrismaClient();
const repository = new RouteRepository(prisma);

const CARRIER = "biz-composition-race";
const DRIVER = "drv-composition-race";
const SHIPPER = "shp-composition-race";

let deliverySeq = 0;
let vehicleSeq = 0;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function seedCarrier(): Promise<void> {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora Corrida",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: "11222333000199",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "corrida@exemplo.com.br",
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
      cnh: "cnh-composition-race",
      cpf: "cpf-composition-race",
      rg: "rg-composition-race",
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
    data: {
      id: "ft-composition-race",
      description: "Diesel",
      businessId: CARRIER,
    },
  });
}

async function seedVehicle(): Promise<string> {
  vehicleSeq += 1;

  const id = `veh-race-${vehicleSeq}`;

  await prisma.vehicle.create({
    data: {
      id,
      description: "Caminhão",
      license_plate: `RCE1A${String(vehicleSeq).padStart(2, "0")}`,
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `renavam-race-${vehicleSeq}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: CARRIER,
      fuelTypeId: "ft-composition-race",
    },
  });

  return id;
}

async function seedDelivery(): Promise<string> {
  deliverySeq += 1;

  const id = `dlv-race-${deliverySeq}`;

  await prisma.delivery.create({
    data: {
      id,
      code: `NF-RACE-${deliverySeq}`,
      recipient_name: `Cliente ${deliverySeq}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER,
      shipperId: SHIPPER,
    },
  });

  return id;
}

/** Create → release: the moment the driver may leave with it. */
async function releasedRoute(
  deliveryIds: string[],
): Promise<{ routeId: string; vehicleId: string }> {
  const vehicleId = await seedVehicle();

  const route = await repository.createRoute({
    businessId: CARRIER,
    driverId: DRIVER,
    vehicleId,
    scheduled_date: new Date(),
    deliveryIds,
  });

  await repository.transitionRoute(route.id, CARRIER, {
    expectedStatus: "PLANNED",
    status: "RELEASED",
  });

  return { routeId: route.id, vehicleId };
}

/**
 * The departure, committed only after `holdMs`. Resolves `holding` once the
 * route row is locked and the load is (uncommitted) on the street.
 */
function holdDeparture(
  routeId: string,
  vehicleId: string,
  holdMs = 400,
): { holding: Promise<void>; departure: Promise<void> } {
  let signal!: () => void;
  const holding = new Promise<void>((done) => (signal = done));

  const departure = prisma.$transaction(
    async (tx) => {
      await repository.transitionRoute(
        routeId,
        CARRIER,
        {
          expectedStatus: "RELEASED",
          status: "IN_PROGRESS",
          vehicleId,
          started_at: new Date(),
        },
        tx,
      );

      signal();

      await sleep(holdMs);
    },
    { timeout: 15_000 },
  );

  return { holding, departure };
}

beforeAll(async () => {
  await seedCarrier();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("composing a route while it departs", () => {
  it("refuses to add a stop to a route that left in the meantime", async () => {
    const onBoard = await seedDelivery();
    const late = await seedDelivery();

    const { routeId, vehicleId } = await releasedRoute([onBoard]);

    const { holding, departure } = holdDeparture(routeId, vehicleId);

    await holding;

    const [departed, added] = await Promise.allSettled([
      departure,
      repository.addStops(routeId, CARRIER, [late]),
    ]);

    expect(departed.status).toBe("fulfilled");

    // Before: the add read RELEASED, the departure moved only the stops it
    // could see, and the late one landed PENDING on a running route — seen by
    // the driver, refused at arrival and proof, and holding the route open.
    expect(added.status, "a parada entrou numa rota que já saiu").toBe(
      "rejected",
    );
    expect((added as PromiseRejectedResult).reason).toBeInstanceOf(
      RouteStatusConflictError,
    );

    expect(await prisma.routeStop.count({ where: { deliveryId: late } })).toBe(
      0,
    );

    const row = await prisma.delivery.findUniqueOrThrow({
      where: { id: late },
    });

    expect(row.status).toBe("PENDING");
    expect(row.driverId).toBeNull();
  }, 30_000);

  it("refuses to remove a stop from a route that left in the meantime", async () => {
    const delivery = await seedDelivery();

    const { routeId, vehicleId } = await releasedRoute([delivery]);

    const stop = await prisma.routeStop.findFirstOrThrow({
      where: { routeId, deliveryId: delivery },
    });

    const { holding, departure } = holdDeparture(routeId, vehicleId);

    await holding;

    const [departed, removed] = await Promise.allSettled([
      departure,
      repository.removeStops(routeId, CARRIER, [stop.id]),
    ]);

    expect(departed.status).toBe("fulfilled");

    // Before: the load left (IN_TRANSIT, customer told) and then lost its stop
    // and its driver — gone from the phone, on the street for nobody.
    expect(removed.status, "a parada saiu de uma rota que já partiu").toBe(
      "rejected",
    );
    expect((removed as PromiseRejectedResult).reason).toBeInstanceOf(
      RouteStatusConflictError,
    );

    const row = await prisma.delivery.findUniqueOrThrow({
      where: { id: delivery },
    });

    expect(row.status).toBe("IN_TRANSIT");
    expect(row.driverId).toBe(DRIVER);

    const kept = await prisma.routeStop.findUniqueOrThrow({
      where: { id: stop.id },
    });

    expect(kept.status).toBe("PENDING");
  }, 30_000);

  it("refuses to detach a delivery whose route left in the meantime", async () => {
    const delivery = await seedDelivery();

    const { routeId, vehicleId } = await releasedRoute([delivery]);

    const { holding, departure } = holdDeparture(routeId, vehicleId);

    await holding;

    const [departed, detached] = await Promise.allSettled([
      departure,
      repository.detachFromOpenRoutes([delivery], CARRIER),
    ]);

    expect(departed.status).toBe("fulfilled");
    expect(detached.status).toBe("fulfilled");

    // The decision is made after the route row is locked, so the departure
    // that committed first is what it sees: the delivery is on a route that
    // left, and nothing is written.
    const outcome = (
      detached as PromiseFulfilledResult<{
        detached: number;
        blocked: string[];
      }>
    ).value;

    expect(outcome.detached).toBe(0);
    expect(outcome.blocked).toHaveLength(1);

    expect(await prisma.routeStop.count({ where: { routeId } })).toBe(1);

    const row = await prisma.delivery.findUniqueOrThrow({
      where: { id: delivery },
    });

    expect(row.status).toBe("IN_TRANSIT");
    expect(row.driverId).toBe(DRIVER);
  }, 30_000);

  it("refuses to reorder a route that left in the meantime", async () => {
    const first = await seedDelivery();
    const second = await seedDelivery();

    const { routeId, vehicleId } = await releasedRoute([first, second]);

    const stops = await prisma.routeStop.findMany({
      where: { routeId },
      orderBy: { sequence: "asc" },
    });

    const { holding, departure } = holdDeparture(routeId, vehicleId);

    await holding;

    const [departed, reordered] = await Promise.allSettled([
      departure,
      repository.reorderStops(
        routeId,
        CARRIER,
        stops.map((stop) => stop.id).reverse(),
      ),
    ]);

    expect(departed.status).toBe("fulfilled");
    expect(reordered.status).toBe("rejected");
    expect((reordered as PromiseRejectedResult).reason).toBeInstanceOf(
      RouteStatusConflictError,
    );

    const after = await prisma.routeStop.findMany({
      where: { routeId },
      orderBy: { sequence: "asc" },
    });

    expect(after.map((stop) => stop.id)).toEqual(stops.map((stop) => stop.id));
  }, 30_000);
});

describe("the stop follows the delivery off the route (IDEMP-11)", () => {
  it("releases a delivery returned to the pool from a running route", async () => {
    const postponed = await seedDelivery();
    const other = await seedDelivery();

    const { routeId, vehicleId } = await releasedRoute([postponed, other]);

    await repository.transitionRoute(routeId, CARRIER, {
      expectedStatus: "RELEASED",
      status: "IN_PROGRESS",
      vehicleId,
      started_at: new Date(),
    });

    const settled = await repository.settleStopForDelivery(postponed, CARRIER, {
      from: ["PENDING", "ARRIVED"],
      status: "CANCELLED",
      releaseDelivery: true,
    });

    expect(settled?.stop.status).toBe("CANCELLED");

    const row = await prisma.delivery.findUniqueOrThrow({
      where: { id: postponed },
    });

    expect(row.driverId).toBeNull();
    expect(row.vehicleId).toBeNull();

    // No longer reserved by the one-open-stop index: it can go on another route.
    await prisma.delivery.update({
      where: { id: postponed },
      data: { status: "PENDING" },
    });

    await expect(
      repository.createRoute({
        businessId: CARRIER,
        driverId: DRIVER,
        vehicleId: await seedVehicle(),
        scheduled_date: new Date(),
        deliveryIds: [postponed],
      }),
    ).resolves.toBeTruthy();
  }, 30_000);

  it("takes a cancelled delivery's stop off a route that has not left", async () => {
    const cancelled = await seedDelivery();
    const kept = await seedDelivery();

    const { routeId } = await releasedRoute([cancelled, kept]);

    await prisma.$transaction(async (tx) => {
      // The order the use cases take: the route first, then the delivery.
      expect(await repository.lockRouteOfOpenStop(cancelled, CARRIER, tx)).toBe(
        routeId,
      );

      await tx.delivery.update({
        where: { id: cancelled },
        data: { status: "CANCELLED" },
      });

      const settled = await repository.settleStopForDelivery(
        cancelled,
        CARRIER,
        { from: ["PENDING", "ARRIVED"], status: "CANCELLED" },
        tx,
      );

      expect(settled).toBeNull();
    });

    // Before: the stop stayed PENDING, rode out with the departure and held
    // the route open forever.
    expect(
      await prisma.routeStop.count({ where: { deliveryId: cancelled } }),
    ).toBe(0);
    expect(await prisma.routeStop.count({ where: { routeId } })).toBe(1);

    const row = await prisma.delivery.findUniqueOrThrow({
      where: { id: cancelled },
    });

    expect(row.driverId).toBeNull();
  }, 30_000);
});

describe("cancelling a route that never left (IDEMP-05)", () => {
  it("does not free the truck that is out on another route", async () => {
    const onTheRoad = await seedDelivery();
    const tomorrow = await seedDelivery();

    const out = await releasedRoute([onTheRoad]);

    await repository.transitionRoute(out.routeId, CARRIER, {
      expectedStatus: "RELEASED",
      status: "IN_PROGRESS",
      vehicleId: out.vehicleId,
      started_at: new Date(),
    });

    const route = await repository.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      vehicleId: out.vehicleId,
      scheduled_date: new Date(),
      deliveryIds: [tomorrow],
    });

    await repository.transitionRoute(route.id, CARRIER, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });

    await repository.transitionRoute(route.id, CARRIER, {
      expectedStatus: "RELEASED",
      status: "CANCELLED",
      cancellation_reason: "Replanejada",
    });

    const truck = await prisma.vehicle.findUniqueOrThrow({
      where: { id: out.vehicleId },
    });

    expect(truck.status, "caminhão na rua marcado como livre").toBe("IN_ROUTE");
  }, 30_000);
});

describe("building a route while one of its deliveries is cancelled", () => {
  it("refuses the route instead of stopping at a cancelled address", async () => {
    const delivery = await seedDelivery();

    let signal!: () => void;
    const holding = new Promise<void>((done) => (signal = done));

    // The panel cancels the delivery; the commit lands while the route is
    // being written.
    const cancellation = prisma.$transaction(
      async (tx) => {
        await tx.delivery.updateMany({
          where: { id: delivery, status: "PENDING" },
          data: { status: "CANCELLED" },
        });

        signal();

        await sleep(400);
      },
      { timeout: 15_000 },
    );

    await holding;

    const vehicleId = await seedVehicle();

    const [cancelled, created] = await Promise.allSettled([
      cancellation,
      repository.createRoute({
        businessId: CARRIER,
        driverId: DRIVER,
        vehicleId,
        scheduled_date: new Date(),
        deliveryIds: [delivery],
      }),
    ]);

    expect(cancelled.status).toBe("fulfilled");

    // Before: an open stop for a CANCELLED delivery — a route that can never
    // close, and a "saiu para entrega" for an order that was called off.
    expect(created.status, "rota criada com entrega cancelada").toBe(
      "rejected",
    );
    expect((created as PromiseRejectedResult).reason).toBeInstanceOf(
      DeliveryNoLongerRoutableError,
    );

    expect(
      await prisma.routeStop.count({ where: { deliveryId: delivery } }),
    ).toBe(0);

    const row = await prisma.delivery.findUniqueOrThrow({
      where: { id: delivery },
    });

    expect(row.status).toBe("CANCELLED");
    expect(row.driverId).toBeNull();
  }, 30_000);

  it("refuses to add it to a route as well", async () => {
    const onBoard = await seedDelivery();
    const cancelledLater = await seedDelivery();

    const { routeId } = await releasedRoute([onBoard]);

    let signal!: () => void;
    const holding = new Promise<void>((done) => (signal = done));

    const cancellation = prisma.$transaction(
      async (tx) => {
        await tx.delivery.updateMany({
          where: { id: cancelledLater, status: "PENDING" },
          data: { status: "CANCELLED" },
        });

        signal();

        await sleep(400);
      },
      { timeout: 15_000 },
    );

    await holding;

    const [cancelled, added] = await Promise.allSettled([
      cancellation,
      repository.addStops(routeId, CARRIER, [cancelledLater]),
    ]);

    expect(cancelled.status).toBe("fulfilled");
    expect(added.status).toBe("rejected");
    expect((added as PromiseRejectedResult).reason).toBeInstanceOf(
      DeliveryNoLongerRoutableError,
    );

    expect(
      await prisma.routeStop.count({ where: { deliveryId: cancelledLater } }),
    ).toBe(0);
  }, 30_000);
});
