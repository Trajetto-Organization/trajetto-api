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
 * answers 200, not the 500 of a deadlock.
 *
 * The pin locks the delivery and then the copies of its previous point
 * (followSource, pre-push review of the batch of 14/11/2026). A route write
 * that adds the two deliveries of that door to a route locks the copy, then
 * the delivery. When the two overlap, each holds what the other needs next:
 * Postgres breaks the cycle after deadlock_timeout by rolling one of them
 * back with 40P01. No lock order on the pin's side rules this out — it only
 * knows the copies once the delivery is locked and read — so the pin runs
 * its transaction again (RouteRepository.pinDeliveryLocation), re-reading
 * the delivery's previous point under its own lock.
 *
 * The route write is the real addStops, driven by hand in two steps — the
 * copy, then (once the pin is provably waiting on it) the delivery — in one
 * transaction, because that gap is the whole race. Its session waits 30 s
 * before looking for a deadlock, so the pin's (1 s, the default) is the one
 * that finds the cycle: the pin is the victim every time, and the route
 * write commits.
 */
const prisma = createPrismaClient();
const repository = new RouteRepository(prisma);

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fea10-0000-7000-8000-00000000000a";
const DRIVER = "018fea10-0000-7000-8000-0000000000d1";
const TRUCK = "018fea10-0000-7000-8000-0000000000e1";
const SHIPPER = "018fea10-0000-7000-8000-0000000000f1";

// The copy sorts before its source, as a route write's updateMany by id
// IN (...) would meet them.
const COPY = "018fea10-0000-7000-8000-000000000c01";
const SOURCE = "018fea10-0000-7000-8000-000000000c02";

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

describe("a pin at the instant a route write takes the same deliveries", () => {
  it("is the deadlock's victim, runs again and answers 200", async () => {
    const key = deliveryAddressKey(DOOR);
    const atTheDoor = {
      ...DOOR,
      address_key: key,
      businessId: CARRIER,
      shipperId: SHIPPER,
    };

    // The source with its own pin, and the copy it handed out.
    await prisma.delivery.create({
      data: {
        id: SOURCE,
        ...atTheDoor,
        recipient_name: "Primeira no Lipold",
        ...OLD_POINT,
        geo_source: "MANUAL",
        geo_updated_at: new Date(),
      },
    });
    await prisma.delivery.create({
      data: {
        id: COPY,
        ...atTheDoor,
        recipient_name: "Segunda no Lipold",
        ...OLD_POINT,
        geo_source: "GEOCODER",
        geo_precision: "ADDRESS",
        geocode_status: "RESOLVED",
        geo_updated_at: new Date(),
        geo_copied_from: SOURCE,
      },
    });

    // A planned route elsewhere, which the two deliveries are being added to.
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

    clearLogged();

    let copyTaken: () => void = () => undefined;
    const routeWriteHoldsTheCopy = new Promise<void>((resolve) => {
      copyTaken = resolve;
    });

    const routeWrite = prisma.$transaction(
      async (tx) => {
        // This side never looks for the deadlock first (see the top).
        await tx.$executeRawUnsafe("SET LOCAL deadlock_timeout = '30s'");

        await repository.addStops(route.id, CARRIER, [COPY], tx);

        copyTaken();

        // The pin holds the source and waits on the copy this one holds...
        await someoneWaitsOnALock(prisma, {
          what: "pin's copies",
          query: "AS follower",
        });

        // ...and the rest of the write reaches for the source.
        return repository.addStops(route.id, CARRIER, [SOURCE], tx);
      },
      { maxWait: 10_000, timeout: 40_000 },
    );

    await routeWriteHoldsTheCopy;

    const pinned = await app.inject({
      method: "PATCH",
      url: `/route/set-delivery-location/${SOURCE}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: NEW_POINT,
    });

    const [written] = await Promise.allSettled([routeWrite]);

    expect(
      written.status,
      written.status === "rejected" ? String(written.reason) : "",
    ).toBe("fulfilled");

    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(pinned.json().data).toMatchObject({
      ...NEW_POINT,
      geo_source: "MANUAL",
      propagated: 1,
    });

    // It was the victim, once, and ran again.
    expect(
      logged("warn").filter(
        (line) =>
          line.msg ===
            "pin transaction aborted by a concurrent write; running it again" &&
          line.deliveryId === SOURCE,
      ),
    ).toEqual([expect.objectContaining({ attempt: 1, sqlState: "40P01" })]);

    // Both writes landed: the copy followed the pin from the point the
    // second attempt read, and both deliveries are on the route.
    expect(
      await prisma.delivery.findUniqueOrThrow({ where: { id: COPY } }),
    ).toMatchObject({
      ...NEW_POINT,
      geo_source: "GEOCODER",
      geo_copied_from: SOURCE,
      driverId: DRIVER,
    });
    expect(
      await prisma.delivery.findUniqueOrThrow({ where: { id: SOURCE } }),
    ).toMatchObject({
      ...NEW_POINT,
      geo_source: "MANUAL",
      geo_copied_from: null,
      driverId: DRIVER,
    });
    expect(
      (
        await prisma.routeStop.findMany({
          where: { routeId: route.id, status: "PENDING" },
          select: { deliveryId: true },
        })
      )
        .map((stop) => stop.deliveryId)
        .sort(),
    ).toEqual([filler.id, COPY, SOURCE].sort());
  }, 60_000);
});
