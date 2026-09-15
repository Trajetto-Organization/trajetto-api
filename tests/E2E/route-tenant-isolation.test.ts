import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import { RouteRepository } from "@/modules/route/repositories/route-repository";

/**
 * Tenant isolation of the route module, against a real Postgres.
 *
 * The unit suite proves the same rules against the in-memory repository, and
 * that fake mirrors them carefully — but a mirror is only as good as the hand
 * that cut it. This runs the ACTUAL Prisma repository, with the actual `where`
 * clauses, against the actual schema and its actual constraints, and tries
 * every cross-tenant reach a hand-written request could make.
 *
 * It uses the prisma environment already configured for `tests/E2E/**`
 * (vite.config.mts): a random schema per run, migrations applied, dropped on
 * teardown. Nothing here touches a shared database.
 */
const prisma = new PrismaClient();
const repository = new RouteRepository(prisma);

const A = "biz-a";
const B = "biz-b";

let routeId: string;
let stopId: string;

async function seedCarrier(id: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: id.padEnd(14, "0"),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.shipper.create({
    data: { id: `shp-${id}`, name: "Embarcador", businessId: id },
  });

  await prisma.driver.create({
    data: {
      id: `drv-${id}`,
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: `${id}-cnh`,
      cpf: `${id}-cpf`,
      rg: `${id}-rg`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: id,
    },
  });

  await prisma.fuelType.create({
    data: { id: `ft-${id}`, description: "Diesel", businessId: id },
  });

  await prisma.vehicle.create({
    data: {
      id: `veh-${id}`,
      description: "Caminhão",
      license_plate: `${id}-plate`,
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `${id}-renavam`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: id,
      fuelTypeId: `ft-${id}`,
    },
  });

  await prisma.delivery.create({
    data: {
      id: `dlv-${id}`,
      recipient_name: "Destinatário",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: id,
      shipperId: `shp-${id}`,
    },
  });
}

beforeAll(async () => {
  await seedCarrier(A);
  await seedCarrier(B);

  const route = await repository.createRoute({
    businessId: A,
    driverId: `drv-${A}`,
    vehicleId: `veh-${A}`,
    scheduled_date: new Date(),
    deliveryIds: [`dlv-${A}`],
  });

  routeId = route.id;
  stopId = route.stops[0].id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("carrier B reaching carrier A's route", () => {
  it("cannot read it", async () => {
    expect(await repository.findRouteById(routeId, B)).toBeNull();
    expect(await repository.findRouteById(routeId, A)).not.toBeNull();
  });

  it("cannot read its stop", async () => {
    expect(await repository.findStopById(stopId, B)).toBeNull();
    expect(await repository.findStopById(stopId, A)).not.toBeNull();
  });

  it("cannot find it through the driver lookup", async () => {
    // Same driver id, wrong carrier. The driver id alone is not authority.
    expect(await repository.findDriverRoute(B, `drv-${A}`)).toBeNull();
  });

  it("does not see it in a listing", async () => {
    const listing = await repository.listRoutes({
      businessId: B,
      page: 1,
      pageSize: 10,
    });

    expect(listing.total).toBe(0);
    expect(listing.data).toHaveLength(0);
  });

  it("cannot rename it", async () => {
    await expect(
      repository.updateRoute(routeId, B, { name: "sequestrada" }),
    ).rejects.toThrow();
  });

  it("cannot move its status", async () => {
    await expect(
      repository.transitionRoute(routeId, B, {
        expectedStatus: "PLANNED",
        status: "RELEASED",
      }),
    ).rejects.toThrow();
  });

  it("cannot add a stop to it", async () => {
    await expect(
      repository.addStops(routeId, B, [`dlv-${B}`]),
    ).rejects.toThrow();
  });

  it("cannot remove its stop", async () => {
    await expect(repository.removeStop(routeId, B, stopId)).rejects.toThrow();
  });

  it("cannot reorder its stops", async () => {
    await expect(
      repository.reorderStops(routeId, B, [stopId]),
    ).rejects.toThrow();
  });

});

describe("after every refused attempt", () => {
  it("left the route exactly as it was", async () => {
    // The refusals above must be refusals, not partial writes. A `where` that
    // matched nothing writes nothing — this is what proves it.
    const route = await prisma.route.findUniqueOrThrow({
      where: { id: routeId },
    });

    expect(route.status).toBe("PLANNED");
    expect(route.name).toBeNull();
    expect(route.driverId).toBe(`drv-${A}`);
    expect(route.vehicleId).toBe(`veh-${A}`);
  });

  it("left the stops exactly as they were", async () => {
    const stops = await prisma.routeStop.findMany({ where: { routeId } });

    expect(stops).toHaveLength(1);
    expect(stops[0].status).toBe("PENDING");
  });

  it("never stamped carrier A's driver on carrier B's delivery", async () => {
    // The mirror onto Delivery.driverId is the one write in this module that
    // touches a table the route does not own. Unscoped, a crafted id would
    // have let A's driver appear on B's own screens.
    const foreign = await prisma.delivery.findUniqueOrThrow({
      where: { id: `dlv-${B}` },
    });

    expect(foreign.driverId).toBeNull();
    expect(foreign.vehicleId).toBeNull();
  });
});

describe("carrier A still operates its own route", () => {
  it("renames it", async () => {
    const updated = await repository.updateRoute(routeId, A, {
      name: "Zona Sul — manhã",
    });

    expect(updated.name).toBe("Zona Sul — manhã");
  });

  it("releases it", async () => {
    const released = await repository.transitionRoute(routeId, A, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });

    expect(released.status).toBe("RELEASED");
  });

  it("refuses a transition from the wrong expected status", async () => {
    // Tenant is right, precondition is not: the route already moved. Same
    // empty result set, same refusal — which is the point of putting both in
    // one `where`.
    await expect(
      repository.transitionRoute(routeId, A, {
        expectedStatus: "PLANNED",
        status: "IN_PROGRESS",
      }),
    ).rejects.toThrow();
  });

  it("starts it", async () => {
    const started = await repository.transitionRoute(routeId, A, {
      expectedStatus: "RELEASED",
      status: "IN_PROGRESS",
      started_at: new Date(),
    });

    expect(started.status).toBe("IN_PROGRESS");
  });
});

/**
 * Settling only means anything on a route that is running, which is why these
 * live after the departure above. Ordered inside the block on purpose: the
 * refusal has to be measured against a call that would otherwise have worked.
 */
describe("settling the stop of a running route", () => {
  it("refuses carrier B and writes nothing", async () => {
    // Null rather than a throw: settling is a consequence of a delivery
    // outcome, and a route with nothing to say must not undo a proof that was
    // already accepted. So the assertion that carries the weight is the state
    // of the row afterwards.
    expect(
      await repository.settleStopForDelivery(`dlv-${A}`, B, {
        from: ["PENDING", "ARRIVED"],
        status: "COMPLETED",
        completed_at: new Date(),
      }),
    ).toBeNull();

    const stop = await prisma.routeStop.findUniqueOrThrow({
      where: { id: stopId },
    });

    expect(stop.status).toBe("PENDING");
    expect(stop.completed_at).toBeNull();
  });

  it("refuses a delivery id from carrier B against carrier A", async () => {
    // The other direction of the same crafted request: a real delivery id,
    // the caller's own company, but that delivery has no stop here.
    expect(
      await repository.settleStopForDelivery(`dlv-${B}`, B, {
        from: ["PENDING", "ARRIVED"],
        status: "COMPLETED",
        completed_at: new Date(),
      }),
    ).toBeNull();
  });

  it("settles for carrier A and closes the route, since it was the last stop", async () => {
    const settled = await repository.settleStopForDelivery(`dlv-${A}`, A, {
      from: ["PENDING", "ARRIVED"],
      status: "COMPLETED",
      completed_at: new Date(),
    });

    expect(settled).not.toBeNull();
    expect(settled!.stop.status).toBe("COMPLETED");

    // Nobody pressed a button: the route ended because its last stop did.
    expect(settled!.closedRoute?.status).toBe("COMPLETED");
    expect(settled!.closedRoute?.completed_at).not.toBeNull();
  });

  it("is a no-op on the resend, not a second close", async () => {
    expect(
      await repository.settleStopForDelivery(`dlv-${A}`, A, {
        from: ["PENDING", "ARRIVED"],
        status: "COMPLETED",
        completed_at: new Date(),
      }),
    ).toBeNull();

    const stops = await prisma.routeStop.findMany({ where: { routeId } });

    expect(stops).toHaveLength(1);
    expect(stops[0].status).toBe("COMPLETED");
  });
});
