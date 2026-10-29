import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { DeliveryAlreadyOnRouteError } from "@/modules/route/usecases/errors/route-errors";
import { createPrismaClient } from "@/shared/database/database-client";

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
const prisma = createPrismaClient();
const repository = new RouteRepository(prisma);
const deliveries = new DeliveryRepository(prisma);

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

    const row = await prisma.route.findUniqueOrThrow({
      where: { id: routeId },
    });

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

  it("refuses a duplicate inside a BATCH, and adds none of it", async () => {
    /**
     * `addStops` writes every stop in one INSERT now, and that changes what a
     * duplicate does.
     *
     * It used to insert them one at a time in a loop — forty round trips with
     * the row locks held for a forty-stop morning — so a duplicate in the
     * middle of a batch failed on its own statement with the earlier ones
     * already written, and the transaction rolled them back. One statement
     * fails as one statement, and the rollback has to still leave the route
     * exactly as it was: a dispatcher who pasted a list with one address
     * already routed must not end up with half of it added.
     */
    const route = await repository.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      scheduled_date: new Date(),
      deliveryIds: [],
    });

    const taken = await seedDelivery();
    const fresh = await seedDelivery();
    const alsoFresh = await seedDelivery();

    await repository.addStops(route.id, CARRIER, [taken]);

    await expect(
      repository.addStops(route.id, CARRIER, [fresh, taken, alsoFresh]),
    ).rejects.toBeInstanceOf(DeliveryAlreadyOnRouteError);

    // Neither of the good ones landed: all of it, or none of it.
    expect(await stopsOf(fresh)).toHaveLength(0);
    expect(await stopsOf(alsoFresh)).toHaveLength(0);

    // And the one that was already there is still there, once.
    expect(await stopsOf(taken)).toHaveLength(1);
  });

  it("and numbers a batch in the order it was given", async () => {
    /**
     * The sequences are what the driver's screen follows, and they are now
     * computed in JavaScript before a single row is written rather than read
     * back after each insert. Spaced by ten, continuing from whatever the
     * route already had.
     */
    const route = await repository.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      scheduled_date: new Date(),
      deliveryIds: [],
    });

    const first = await seedDelivery();
    const second = await seedDelivery();
    const third = await seedDelivery();

    await repository.addStops(route.id, CARRIER, [first]);

    const { stops: added } = await repository.addStops(route.id, CARRIER, [
      second,
      third,
    ]);

    expect(added.map((stop) => stop.deliveryId)).toEqual([second, third]);

    const sequences = added.map((stop) => stop.sequence);

    expect(sequences[1]).toBeGreaterThan(sequences[0]);

    // Continuing from the existing stop, not restarting.
    const existing = (await stopsOf(first))[0];

    expect(sequences[0]).toBeGreaterThan(existing.sequence);
  });

  it("lets a failed attempt be re-delivered, and keeps the attempt", async () => {
    const delivery = await seedDelivery();
    const firstRoute = await runningRoute([delivery]);

    await repository.settleStopForDelivery(delivery, CARRIER, {
      from: ["PENDING", "ARRIVED"],
      status: "FAILED",
      completed_at: new Date(),
    });

    // The redelivery decision (FAILED → PENDING) the use cases would have
    // recorded: only a PENDING delivery may join a route, and the route write
    // itself refuses anything else (IDEMP-06).
    await prisma.delivery.update({
      where: { id: delivery },
      data: { status: "PENDING" },
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

describe("the batch departure and the route, side by side", () => {
  /**
   * Two dispatch models coexist while the app migrates: deliveries assigned in
   * a batch, and deliveries on a route. The batch departure matches on
   * `driverId` — and a delivery sitting on a PLANNED route already carries it,
   * because that is the route's shadow, written when the dispatcher built it.
   *
   * The relation filter that keeps them apart is a Prisma `stops: { none: … }`
   * and exists nowhere else, so this is the only place it can be proven.
   */
  it("leaves a planned route's load alone", async () => {
    const planned = await seedDelivery();

    const route = await repository.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      vehicleId: await seedVehicle(),
      scheduled_date: new Date(),
      deliveryIds: [planned],
    });

    expect((await deliveryRow(planned)).driverId).toBe(DRIVER);

    // What the old endpoint would have swept up.
    expect(await deliveries.countPendingForDriver(CARRIER, DRIVER)).toBe(0);
    expect(await deliveries.startDriverRoute(CARRIER, DRIVER)).toBe(0);

    // Still planned, still in the yard.
    const row = await prisma.route.findUniqueOrThrow({
      where: { id: route.id },
    });

    expect(row.status).toBe("PLANNED");
    expect((await deliveryRow(planned)).status).toBe("PENDING");
  });

  it("still moves a delivery assigned by hand", async () => {
    // Batch assignment has not gone away, and the filter must not swallow it.
    const loose = await seedDelivery();

    await prisma.delivery.update({
      where: { id: loose },
      data: { driverId: DRIVER },
    });

    expect(await deliveries.countPendingForDriver(CARRIER, DRIVER)).toBe(1);
    expect(await deliveries.startDriverRoute(CARRIER, DRIVER)).toBe(1);
    expect((await deliveryRow(loose)).status).toBe("IN_TRANSIT");
  });

  it("stops matching a delivery once its attempt is closed", async () => {
    // A stop that FAILED no longer reserves its delivery — neither for a new
    // route nor for the batch. The filter asks about OPEN stops only.
    const delivery = await seedDelivery();

    await runningRoute([delivery]);

    await repository.settleStopForDelivery(delivery, CARRIER, {
      from: ["PENDING", "ARRIVED"],
      status: "FAILED",
      completed_at: new Date(),
    });

    await prisma.delivery.update({
      where: { id: delivery },
      data: { status: "PENDING", driverId: DRIVER },
    });

    expect(await deliveries.countPendingForDriver(CARRIER, DRIVER)).toBe(1);
  });
});

describe("“Em rota” written by the route and nothing else", () => {
  async function statusOf(id: string) {
    return (await prisma.vehicle.findUniqueOrThrow({ where: { id } })).status;
  }

  it("marks the truck out on departure and free when the route closes", async () => {
    const delivery = await seedDelivery();
    const vehicle = await seedVehicle();

    expect(await statusOf(vehicle)).toBe("ACTIVE");

    const routeId = await runningRoute([delivery], vehicle);

    expect(await statusOf(vehicle)).toBe("IN_ROUTE");

    await repository.settleStopForDelivery(delivery, CARRIER, {
      from: ["PENDING", "ARRIVED"],
      status: "COMPLETED",
      completed_at: new Date(),
    });

    // The route closed on its own last stop, inside the same transaction, and
    // the truck came back with it.
    const closed = await prisma.route.findUniqueOrThrow({
      where: { id: routeId },
    });

    expect(closed.status).toBe("COMPLETED");
    expect(await statusOf(vehicle)).toBe("ACTIVE");
  });

  it("frees the truck when the route is cancelled mid-way", async () => {
    const vehicle = await seedVehicle();
    const routeId = await runningRoute([await seedDelivery()], vehicle);

    await repository.transitionRoute(routeId, CARRIER, {
      expectedStatus: "IN_PROGRESS",
      status: "CANCELLED",
      cancellation_reason: "Pane elétrica",
    });

    expect(await statusOf(vehicle)).toBe("ACTIVE");
  });

  it("does not reopen a truck blocked while it was on the road", async () => {
    // Why both writes are conditional. A vehicle blocked BECAUSE of what
    // happened on the road must not be returned to service by the paperwork.
    const vehicle = await seedVehicle();
    const routeId = await runningRoute([await seedDelivery()], vehicle);

    await prisma.vehicle.update({
      where: { id: vehicle },
      data: { status: "BLOCKED" },
    });

    await repository.transitionRoute(routeId, CARRIER, {
      expectedStatus: "IN_PROGRESS",
      status: "CANCELLED",
      cancellation_reason: "Veículo apreendido",
    });

    expect(await statusOf(vehicle)).toBe("BLOCKED");
  });

  it("does not drag a blocked truck out at departure", async () => {
    const vehicle = await seedVehicle();

    await prisma.vehicle.update({
      where: { id: vehicle },
      data: { status: "BLOCKED" },
    });

    const route = await repository.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      vehicleId: vehicle,
      scheduled_date: new Date(),
      deliveryIds: [await seedDelivery()],
    });

    await repository.transitionRoute(route.id, CARRIER, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });

    // The repository takes the transition it is given — the use case is what
    // refuses a blocked vehicle, and that is tested in the unit suite. What
    // this pins is that even if a departure DOES reach here, the vehicle write
    // only ever moves ACTIVE and leaves BLOCKED alone.
    await repository.transitionRoute(route.id, CARRIER, {
      expectedStatus: "RELEASED",
      status: "IN_PROGRESS",
      started_at: new Date(),
    });

    expect(await statusOf(vehicle)).toBe("BLOCKED");
  });
});

describe("what the driver's phone receives", () => {
  /**
   * The app renders the day from a seven-day offline cache, so the order the
   * dispatcher chose has to TRAVEL with the payload — a second endpoint would
   * be a second thing to go stale on a phone with no signal, and the sort
   * happens on the device because by then the server's order is long gone.
   */
  it("carries the open stop, its sequence and the route it belongs to", async () => {
    const first = await seedDelivery();
    const second = await seedDelivery();

    await runningRoute([first, second]);

    const rows = (await deliveries.listDriverDeliveries(
      CARRIER,
      DRIVER,
    )) as Array<{
      id: string;
      stops: Array<{
        sequence: number;
        status: string;
        route: { code: number; status: string };
      }>;
    }>;

    // Scoped to what this test created: earlier tests in the file left their
    // own routes running for the same driver, and the driver list is the
    // whole day by design.
    const routed = rows.filter(
      (row) => (row.id === first || row.id === second) && row.stops.length > 0,
    );

    expect(routed).toHaveLength(2);

    // At most one stop each: the partial unique index allows a delivery
    // exactly one open one, which is why the app reads stops[0].
    for (const row of routed) {
      expect(row.stops).toHaveLength(1);
      expect(row.stops[0].route.status).toBe("IN_PROGRESS");
    }

    const sequences = routed.map((row) => row.stops[0].sequence).sort();

    expect(sequences).toEqual([10, 20]);
  });

  it("stops carrying a stop once the address is resolved", async () => {
    // The include asks for OPEN stops only. An address already worked, still
    // arriving on the phone with a position, is a stop the driver would be
    // told to go back to.
    const delivery = await seedDelivery();

    await runningRoute([delivery]);

    const before = (await deliveries.listDriverDeliveries(
      CARRIER,
      DRIVER,
    )) as Array<{ id: string; stops: unknown[] }>;

    expect(before.find((row) => row.id === delivery)!.stops).toHaveLength(1);

    await repository.settleStopForDelivery(delivery, CARRIER, {
      from: ["PENDING", "ARRIVED"],
      status: "COMPLETED",
      completed_at: new Date(),
    });

    const after = (await deliveries.listDriverDeliveries(
      CARRIER,
      DRIVER,
    )) as Array<{ id: string; stops: unknown[] }>;

    // The delivery is still IN_TRANSIT here — settling a stop at the
    // repository level does not move it; that is the delivery use case's job,
    // and the app's own outcome does both in one commit. What matters is that
    // the resolved stop no longer travels.
    expect(after.find((row) => row.id === delivery)!.stops).toEqual([]);
  });

  it("sends an empty list, not a missing key, for work with no route", async () => {
    // The app treats a missing key as "cached before this existed" and an
    // empty array as "not on a route". They must not be confused.
    const loose = await seedDelivery();

    // IN_TRANSIT: the only loose work the phone still gets (D8). A PENDING
    // delivery with a driver and no route is the old direct assignment.
    await prisma.delivery.update({
      where: { id: loose },
      data: { driverId: DRIVER, status: "IN_TRANSIT" },
    });

    const rows = (await deliveries.listDriverDeliveries(
      CARRIER,
      DRIVER,
    )) as Array<{ id: string; stops: unknown[] }>;

    const row = rows.find((entry) => entry.id === loose);

    expect(row).toBeDefined();
    expect(row!.stops).toEqual([]);
  });
});

/**
 * Decision 14.7, D8 (design §4.13): the route is the unit of assignment, and a
 * route still being planned is a draft the driver must not see change while
 * the dispatcher drags it. The phone gets what is IN_TRANSIT, and what is
 * PENDING on a RELEASED or IN_PROGRESS route.
 */
describe("what the driver's phone receives from a route being planned (D8)", () => {
  async function listed(deliveryId: string) {
    const rows = (await deliveries.listDriverDeliveries(
      CARRIER,
      DRIVER,
    )) as Array<{
      id: string;
      stops: Array<{ route: { id: string; plan_version: number } }>;
    }>;

    return rows.find((row) => row.id === deliveryId);
  }

  it("leaves out a delivery on a PLANNED route, and shows it once released", async () => {
    const delivery = await seedDelivery();

    const route = await repository.createRoute({
      businessId: CARRIER,
      driverId: DRIVER,
      vehicleId: await seedVehicle(),
      scheduled_date: new Date(),
      deliveryIds: [delivery],
    });

    expect((await deliveryRow(delivery)).driverId).toBe(DRIVER);
    expect(await listed(delivery)).toBeUndefined();

    await repository.transitionRoute(route.id, CARRIER, {
      expectedStatus: "PLANNED",
      status: "RELEASED",
    });

    const row = await listed(delivery);

    expect(row).toBeDefined();
    // The app keeps the plan's version in its cache to notice a change
    // made while it was offline (design §6).
    expect(row!.stops[0].route).toMatchObject({
      id: route.id,
      plan_version: expect.any(Number),
    });
  });

  it("leaves out a PENDING delivery designated with no route", async () => {
    const loose = await seedDelivery();

    await prisma.delivery.update({
      where: { id: loose },
      data: { driverId: DRIVER },
    });

    expect(await listed(loose)).toBeUndefined();
  });
});

describe("the last two stops settled at the same instant", () => {
  /**
   * A write skew the unit suite cannot see.
   *
   * Each settle updated its OWN stop and then counted the open ones. Under
   * READ COMMITTED neither transaction sees the other's uncommitted stop, so
   * both counted one still open and neither closed the route. It happens in
   * the field: the app's outbox sends a proof queued in a dead zone at the
   * same moment the driver, back online, proves the next address — or the
   * panel settles one while the phone settles the other.
   *
   * Nothing ever repaired it. The route stayed IN_PROGRESS with nothing left
   * to do, the truck stayed "Em rota" and refused its next departure
   * (ROUTE_VEHICLE_BUSY), the driver's GPS kept being recorded, and the ERP
   * never heard `route.completed`. The only way out was cancelling a route
   * that had been fully delivered.
   */
  it("still closes the route and brings the truck back", async () => {
    const first = await seedDelivery();
    const second = await seedDelivery();
    const vehicle = await seedVehicle();

    const routeId = await runningRoute([first, second], vehicle);

    const proof = () => ({
      from: ["PENDING", "ARRIVED"] as Array<"PENDING" | "ARRIVED">,
      status: "COMPLETED" as const,
      completed_at: new Date(),
    });

    let firstSettled!: () => void;
    const settledOnce = new Promise<void>((done) => (firstSettled = done));

    // The first proof has settled its stop but not committed yet.
    const one = prisma.$transaction(
      async (tx) => {
        await repository.settleStopForDelivery(first, CARRIER, proof(), tx);

        firstSettled();

        await new Promise((done) => setTimeout(done, 400));
      },
      { timeout: 15_000 },
    );

    await settledOnce;

    // The second arrives inside that window.
    const two = prisma.$transaction(
      (tx) => repository.settleStopForDelivery(second, CARRIER, proof(), tx),
      { timeout: 15_000 },
    );

    await Promise.all([one, two]);

    const route = await prisma.route.findUniqueOrThrow({
      where: { id: routeId },
    });
    const stops = await prisma.routeStop.findMany({ where: { routeId } });
    const truck = await prisma.vehicle.findUniqueOrThrow({
      where: { id: vehicle },
    });

    expect(stops.map((stop) => stop.status)).toEqual([
      "COMPLETED",
      "COMPLETED",
    ]);
    expect(route.status, "rota zumbi: nada aberto e ainda IN_PROGRESS").toBe(
      "COMPLETED",
    );
    expect(truck.status).toBe("ACTIVE");
  }, 30_000);
});
