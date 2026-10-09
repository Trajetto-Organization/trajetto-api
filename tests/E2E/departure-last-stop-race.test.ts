import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * A departure racing the removal of the route's last stop (IDEMP-05/06
 * review), over real HTTP.
 *
 * start-route refuses a route with no open stop (ROUTE_WITHOUT_STOPS), but it
 * decided that from the route it read BEFORE its transaction. A removal that
 * commits between that read and the departure's UPDATE — the dispatcher's
 * removeStop, or a cancellation that now takes the stop off the plan — does
 * not touch the route's status, so the conditional UPDATE still matched and
 * the route left with nothing on it: IN_PROGRESS forever (a route closes when
 * its last open stop resolves), the truck "Em rota".
 *
 * The removal is held open with the route row locked, the way removeStop
 * holds it, so the interleaving is forced rather than hoped for.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fd600-0000-7000-8000-00000000000a";

const DISPATCHER = "018fd600-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018fd600-0000-7000-8000-0000000000a2";
const DRIVER = "018fd600-0000-7000-8000-0000000000d1";
const TRUCK = "018fd600-0000-7000-8000-0000000000c1";
const SHIPPER = "018fd600-0000-7000-8000-0000000000f1";

let dispatcherToken = "";
let driverToken = "";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function tokenFor(
  userId: string,
  driverId: string | null,
): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    {
      tokenType: "access",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
      driverId,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora Largada",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(62000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `largada-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  const profile = await prisma.profileAccess.create({
    data: {
      name: "Despacho",
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: "Gerenciar entregas",
            canRead: true,
            canWrite: true,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João",
      birth_date: new Date("1990-01-01"),
      cnh: `CNHLARG${randomUUID().slice(0, 4)}`,
      cpf: `${String(Date.now()).slice(-10)}7`,
      rg: randomUUID().slice(0, 9),
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

  const vehicleType = await prisma.vehicleType.create({
    data: {
      description: `Truck ${randomUUID().slice(0, 6)}`,
      number_of_axles: 2,
      businessId: CARRIER,
    },
  });

  const fuelType = await prisma.fuelType.create({
    data: { description: `Diesel ${randomUUID().slice(0, 6)}`, businessId: CARRIER },
  });

  await prisma.vehicle.create({
    data: {
      id: TRUCK,
      description: "Caminhão LRG1A11",
      license_plate: "LRG1A11",
      brand: "Marca",
      model: "Modelo",
      acquisition_date: new Date("2022-01-01"),
      fleet_type: "OWNED",
      current_mileage: 1000,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: String(Date.now()).slice(-11),
      manufacturing_year: new Date("2020-01-01"),
      model_year: new Date("2020-01-01"),
      km_per_liter: 3,
      number_of_axles: 2,
      status: "ACTIVE",
      businessId: CARRIER,
      vehicleTypeId: vehicleType.id,
      fuelTypeId: fuelType.id,
    },
  });

  await prisma.user.createMany({
    data: [
      {
        id: DISPATCHER,
        name: "Despachante",
        email: `despacho-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
        profileAccessId: profile.id,
      },
      {
        id: DRIVER_USER,
        name: "João",
        email: `joao-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        driverId: DRIVER,
        profileAccessId: profile.id,
      },
    ],
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  dispatcherToken = await tokenFor(DISPATCHER, null);
  driverToken = await tokenFor(DRIVER_USER, DRIVER);

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("a departure racing the removal of the last stop", () => {
  it("refuses to leave with an empty route and writes nothing", async () => {
    const delivery = await prisma.delivery.create({
      data: {
        businessId: CARRIER,
        shipperId: SHIPPER,
        code: "NF-LARG-1",
        recipient_name: "Cliente",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        status: "PENDING",
      },
    });

    const assigned = await app.inject({
      method: "PATCH",
      url: `/delivery/assign-deliveries/${CARRIER}`,
      headers: { authorization: `Bearer ${dispatcherToken}` },
      payload: { deliveryIds: [delivery.id], driverId: DRIVER, vehicleId: TRUCK },
    });

    expect(assigned.statusCode, assigned.body.slice(0, 300)).toBe(200);

    const routeId: string = assigned.json().data.routeId;

    const stop = await prisma.routeStop.findFirstOrThrow({
      where: { routeId, deliveryId: delivery.id },
    });

    let signal!: () => void;
    const removing = new Promise<void>((done) => (signal = done));

    // removeStop, held open: the route row locked first (as removeStop takes
    // it), the stop deleted and the shadow cleared, not committed yet.
    const removal = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "route" WHERE "id" = ${routeId} FOR UPDATE
        `;

        await tx.routeStop.delete({ where: { id: stop.id } });

        await tx.delivery.update({
          where: { id: delivery.id },
          data: { driverId: null, vehicleId: null },
        });

        signal();

        await sleep(1_500);
      },
      { timeout: 15_000 },
    );

    await removing;

    // The departure reads the route (the uncommitted delete is invisible:
    // one open stop), passes every check, and its UPDATE waits for the
    // removal's lock — then runs over a route that no longer has a stop.
    const [removed, departed] = await Promise.allSettled([
      removal,
      app.inject({
        method: "POST",
        url: `/route/start-route/${routeId}/business/${CARRIER}`,
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      }),
    ]);

    expect(removed.status).toBe("fulfilled");
    expect(departed.status).toBe("fulfilled");

    const response = (
      departed as PromiseFulfilledResult<Awaited<ReturnType<typeof app.inject>>>
    ).value;

    // Before: 200, and a route IN_PROGRESS with no stop that could never close.
    expect(response.statusCode, response.body.slice(0, 300)).toBe(400);
    expect(response.json().code).toBe("ROUTE_WITHOUT_STOPS");

    const route = await prisma.route.findUniqueOrThrow({ where: { id: routeId } });

    expect(route.status, "rota vazia saiu").toBe("RELEASED");
    expect(route.started_at).toBeNull();

    const truck = await prisma.vehicle.findUniqueOrThrow({ where: { id: TRUCK } });

    expect(truck.status, "caminhão preso em rota vazia").toBe("ACTIVE");

    expect(
      await prisma.domainOutboxEvent.count({
        where: { topic: "delivery.dispatched", aggregateId: delivery.id },
      }),
    ).toBe(0);
  }, 60_000);
});
