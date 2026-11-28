import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { createPrismaClient } from "@/shared/database/database-client";
import { deliveryAddressKey } from "@/shared/delivery/address-key";

import { clearLogged, logged } from "../support/log-capture";
import { someoneWaitsOnALock } from "./support/lock-wait";

vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

/**
 * "Fixar no mapa" at the instant a route write takes the same deliveries
 * answers 200, and so does the route write: neither gets the 500 of a
 * deadlock.
 *
 * The pin writes the delivery and the copies of its point (followSource,
 * pre-push review of the batch of 14/11/2026). A route write that adds the
 * deliveries of that door to a route locks them in one updateMany over id
 * IN (...), which probes the primary key in id order. A pin that locked
 * the source first and its copies after crossed it whenever a copy sorts
 * before its source: the route write held the copy and waited on the
 * source, the pin held the source and waited on the copy, and Postgres
 * rolled one of them back with 40P01 — the route write, whose wait starts
 * first, so the dispatcher adding the stops got the 500 and the pin's
 * retry never ran. The copies are known without the source's point (they
 * name the source in geo_copied_from), so the pin now locks the source and
 * its copies together, in id order, before it reads anything: the route
 * write's order, and the two queue instead of crossing.
 *
 * A writer that takes the two in separate statements against id order can
 * still close the cycle; when the pin is the victim there, it runs its
 * transaction again (RouteRepository.pinDeliveryLocation).
 *
 * The route writes are the real addStops. In the first case it runs in one
 * call: a third session holds the source until the pin and the route write
 * are both provably queued, so the interleaving is the race's, not luck.
 * Its session looks for a deadlock after 100 ms instead of 1 s: it is the
 * side whose wait starts first, the one that finds a cycle when there is
 * one, only sooner. In the second it is driven by hand in two steps, the
 * source and then the copy, and waits 30 s before looking, so the pin (1 s,
 * the default) is the victim every time.
 */
const prisma = createPrismaClient();
const repository = new RouteRepository(prisma);

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fea10-0000-7000-8000-00000000000a";
const DRIVER = "018fea10-0000-7000-8000-0000000000d1";
const TRUCK = "018fea10-0000-7000-8000-0000000000e1";
const SHIPPER = "018fea10-0000-7000-8000-0000000000f1";

// Each copy sorts before its source, as a route write's updateMany by id
// IN (...) meets them.
const ONE_CALL = {
  copy: "018fea10-0000-7000-8000-000000000c11",
  source: "018fea10-0000-7000-8000-000000000c12",
};
const TWO_STEPS = {
  copy: "018fea10-0000-7000-8000-000000000c21",
  source: "018fea10-0000-7000-8000-000000000c22",
};

const DOOR = {
  street: "Rua Doutor Lipold",
  address_number: "10",
  neighborhood: "Carangola",
  city: "Petrópolis",
  uf: "RJ",
};
const OLD_POINT = { latitude: -22.45, longitude: -43.17 };
const NEW_POINT = { latitude: -22.4572, longitude: -43.1688 };

let dispatcher = "";

async function seedDispatcher(): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Despachante",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "15m" },
  );
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Pino",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(58000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `pino-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await prisma.fuelType.create({
    data: { id: `ft-${CARRIER}`, description: "Diesel", businessId: CARRIER },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João",
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${randomUUID().slice(0, 8)}`,
      cpf: `cpf-${randomUUID().slice(0, 8)}`,
      rg: `rg-${randomUUID().slice(0, 8)}`,
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

  await prisma.vehicle.create({
    data: {
      id: TRUCK,
      description: "Caminhão",
      license_plate: "PIN1A11",
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `pino-${randomUUID().slice(0, 8)}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: CARRIER,
      fuelTypeId: `ft-${CARRIER}`,
      driverId: DRIVER,
    },
  });

  dispatcher = await seedDispatcher();

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const RETRY_LINE =
  "pin transaction aborted by a concurrent write; running it again";

/**
 * The source with its own pin, and the copy it handed out. The copy is the
 * older delivery, located later from the source's pin (the review's case),
 * so it comes first by id, by creation, by updated_at (the geocoder's write
 * leaves it) and in the heap: whichever path the route write's updateMany
 * takes — on this file's handful of rows the planner picks an index on the
 * company, not the primary key it walks on a table of real size — it meets
 * the copy first, as production's does.
 */
async function seedDoor({ copy, source }: { copy: string; source: string }) {
  const atTheDoor = {
    ...DOOR,
    address_key: deliveryAddressKey(DOOR),
    businessId: CARRIER,
    shipperId: SHIPPER,
  };
  const created = new Date(Date.now() - 60 * 60 * 1000);

  await prisma.delivery.create({
    data: {
      id: copy,
      ...atTheDoor,
      recipient_name: "Primeira no Lipold",
      ...OLD_POINT,
      geo_source: "GEOCODER",
      geo_precision: "ADDRESS",
      geocode_status: "RESOLVED",
      geo_updated_at: new Date(),
      geo_copied_from: source,
      created_at: created,
      updated_at: created,
    },
  });
  await prisma.delivery.create({
    data: {
      id: source,
      ...atTheDoor,
      recipient_name: "Segunda no Lipold",
      ...OLD_POINT,
      geo_source: "MANUAL",
      geo_updated_at: new Date(),
    },
  });
}

/** A planned route elsewhere, which the door's deliveries are added to. */
async function plannedRoute() {
  const filler = await prisma.delivery.create({
    data: {
      recipient_name: "Outra porta",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      address_number: "5",
      businessId: CARRIER,
      shipperId: SHIPPER,
    },
  });
  const route = await repository.createRoute({
    businessId: CARRIER,
    driverId: DRIVER,
    vehicleId: TRUCK,
    scheduled_date: new Date(),
    deliveryIds: [filler.id],
  });

  return { routeId: route.id, fillerId: filler.id };
}

function pinOnTheMap(source: string) {
  return app.inject({
    method: "PATCH",
    url: `/route/set-delivery-location/${source}/business/${CARRIER}`,
    headers: { authorization: `Bearer ${dispatcher}` },
    payload: NEW_POINT,
  });
}

/** The pin's retries of this delivery, as its warn lines tell them. */
function retriesOf(source: string) {
  return logged("warn").filter(
    (line) => line.msg === RETRY_LINE && line.deliveryId === source,
  );
}

/**
 * Both writes landed: the copy followed the pin, and both deliveries are
 * on the route.
 */
async function expectBothLanded(
  { copy, source }: { copy: string; source: string },
  { routeId, fillerId }: { routeId: string; fillerId: string },
) {
  expect(
    await prisma.delivery.findUniqueOrThrow({ where: { id: copy } }),
  ).toMatchObject({
    ...NEW_POINT,
    geo_source: "GEOCODER",
    geo_copied_from: source,
    driverId: DRIVER,
  });
  expect(
    await prisma.delivery.findUniqueOrThrow({ where: { id: source } }),
  ).toMatchObject({
    ...NEW_POINT,
    geo_source: "MANUAL",
    geo_copied_from: null,
    driverId: DRIVER,
  });
  expect(
    (
      await prisma.routeStop.findMany({
        where: { routeId, status: "PENDING" },
        select: { deliveryId: true },
      })
    )
      .map((stop) => stop.deliveryId)
      .sort(),
  ).toEqual([fillerId, copy, source].sort());
}

describe("a pin at the instant a route write takes the same deliveries", () => {
  it("queues with a route write that adds the copy and its source in one call", async () => {
    await seedDoor(ONE_CALL);
    const route = await plannedRoute();

    clearLogged();

    // A third session holds the source, so the pin parks on its first lock
    // and the route write is provably queued before either goes on.
    let sourceHeld: () => void = () => undefined;
    let release: () => void = () => undefined;
    const holdsTheSource = new Promise<void>((resolve) => {
      sourceHeld = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT 1 FROM "delivery" WHERE "id" = ${ONE_CALL.source}
          FOR NO KEY UPDATE
        `;

        sourceHeld();

        await released;
      },
      { maxWait: 10_000, timeout: 40_000 },
    );

    await holdsTheSource;

    const pinned = pinOnTheMap(ONE_CALL.source);

    await someoneWaitsOnALock(prisma, {
      what: "pin's lock",
      query: "FOR NO KEY UPDATE",
    });

    const routeWrite = prisma.$transaction(
      async (tx) => {
        // The side that looks for the deadlock first (see the top).
        await tx.$executeRawUnsafe("SET LOCAL deadlock_timeout = '100ms'");

        return repository.addStops(
          route.routeId,
          CARRIER,
          [ONE_CALL.copy, ONE_CALL.source],
          tx,
        );
      },
      { maxWait: 10_000, timeout: 40_000 },
    );

    await someoneWaitsOnALock(prisma, {
      what: "route write's deliveries",
      query: 'UPDATE "public"."delivery"',
    });

    release();
    await gate;

    const [written] = await Promise.allSettled([routeWrite]);
    const response = await pinned;

    expect(
      written.status,
      written.status === "rejected" ? String(written.reason) : "",
    ).toBe("fulfilled");

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      ...NEW_POINT,
      geo_source: "MANUAL",
      propagated: 1,
    });

    // No cycle, so no victim: the pin never ran twice.
    expect(retriesOf(ONE_CALL.source)).toEqual([]);

    await expectBothLanded(ONE_CALL, route);
  }, 60_000);

  it("is the victim of a writer that takes the source and then the copy, and runs again", async () => {
    await seedDoor(TWO_STEPS);
    const route = await plannedRoute();

    clearLogged();

    let sourceTaken: () => void = () => undefined;
    const routeWriteHoldsTheSource = new Promise<void>((resolve) => {
      sourceTaken = resolve;
    });

    const routeWrite = prisma.$transaction(
      async (tx) => {
        // This side never looks for the deadlock first (see the top).
        await tx.$executeRawUnsafe("SET LOCAL deadlock_timeout = '30s'");

        await repository.addStops(
          route.routeId,
          CARRIER,
          [TWO_STEPS.source],
          tx,
        );

        sourceTaken();

        // The pin holds the copy and waits on the source this one holds...
        await someoneWaitsOnALock(prisma, {
          what: "pin's lock",
          query: "FOR NO KEY UPDATE",
        });

        // ...and the rest of the write reaches for the copy.
        return repository.addStops(
          route.routeId,
          CARRIER,
          [TWO_STEPS.copy],
          tx,
        );
      },
      { maxWait: 10_000, timeout: 40_000 },
    );

    await routeWriteHoldsTheSource;

    const response = await pinOnTheMap(TWO_STEPS.source);

    const [written] = await Promise.allSettled([routeWrite]);

    expect(
      written.status,
      written.status === "rejected" ? String(written.reason) : "",
    ).toBe("fulfilled");

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      ...NEW_POINT,
      geo_source: "MANUAL",
      propagated: 1,
    });

    // It was the victim, once, and ran again.
    expect(retriesOf(TWO_STEPS.source)).toEqual([
      expect.objectContaining({ attempt: 1, sqlState: "40P01" }),
    ]);

    await expectBothLanded(TWO_STEPS, route);
  }, 60_000);
});
