import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * The batch assignment as one unit of work, over real HTTP (IDEMP-05).
 *
 * The unit file proves the shape — every write joins one transaction, every
 * check runs before the first write. This one proves it against Postgres and
 * the container: that a refused reassignment leaves the previous route as it
 * was, that a resend answers with the route it already made, and that a route
 * emptied by a reassignment is cancelled without marking a truck that is out
 * on another route as free.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fd500-0000-7000-8000-00000000000a";

const DISPATCHER = "018fd500-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018fd500-0000-7000-8000-0000000000a2";

const JOAO = "018fd500-0000-7000-8000-0000000000d1";
const MARIA = "018fd500-0000-7000-8000-0000000000d2";

const TRUCK_1 = "018fd500-0000-7000-8000-0000000000c1";
const TRUCK_2 = "018fd500-0000-7000-8000-0000000000c2";
const TRUCK_3 = "018fd500-0000-7000-8000-0000000000c3";
const TRUCK_4 = "018fd500-0000-7000-8000-0000000000c4";

const SHIPPER = "018fd500-0000-7000-8000-0000000000f1";

let dispatcherToken = "";
let driverToken = "";

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

async function seedDelivery(code: string): Promise<string> {
  const created = await prisma.delivery.create({
    data: {
      businessId: CARRIER,
      shipperId: SHIPPER,
      code,
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status: "PENDING",
    },
  });

  return created.id;
}

function assign(deliveryIds: string[], driverId: string, vehicleId: string) {
  return app.inject({
    method: "PATCH",
    url: `/delivery/assign-deliveries/${CARRIER}`,
    headers: { authorization: `Bearer ${dispatcherToken}` },
    payload: { deliveryIds, driverId, vehicleId },
  });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora Atômica",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(61000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `atomica-${randomUUID()}@exemplo.com.br`,
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

  for (const [id, name, suffix] of [
    [JOAO, "João", "1"],
    [MARIA, "Maria", "2"],
  ] as const) {
    await prisma.driver.create({
      data: {
        id,
        name,
        birth_date: new Date("1990-01-01"),
        cnh: `CNHATOM${suffix}${randomUUID().slice(0, 4)}`,
        cpf: `${String(Date.now()).slice(-10)}${suffix}`,
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
  }

  const vehicleType = await prisma.vehicleType.create({
    data: {
      description: `Truck ${randomUUID().slice(0, 6)}`,
      number_of_axles: 2,
      businessId: CARRIER,
    },
  });

  const fuelType = await prisma.fuelType.create({
    data: {
      description: `Diesel ${randomUUID().slice(0, 6)}`,
      businessId: CARRIER,
    },
  });

  for (const [index, [id, plate]] of (
    [
      [TRUCK_1, "ATM1A11"],
      [TRUCK_2, "ATM2B22"],
      [TRUCK_3, "ATM3C33"],
      [TRUCK_4, "ATM4D44"],
    ] as const
  ).entries()) {
    await prisma.vehicle.create({
      data: {
        id,
        description: `Caminhão ${plate}`,
        license_plate: plate,
        brand: "Marca",
        model: "Modelo",
        acquisition_date: new Date("2022-01-01"),
        fleet_type: "OWNED",
        current_mileage: 1000,
        maintenance_interval_km: 10000,
        maintenance_interval_months: 6,
        renavam: String(Date.now() + index).slice(-11),
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
  }

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
        driverId: JOAO,
        profileAccessId: profile.id,
      },
    ],
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  dispatcherToken = await tokenFor(DISPATCHER, null);
  driverToken = await tokenFor(DRIVER_USER, JOAO);

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("a refused reassignment", () => {
  it("leaves the previous route exactly as it was", async () => {
    const delivery = await seedDelivery("NF-ATOM-1");

    const first = await assign([delivery], JOAO, TRUCK_1);

    expect(first.statusCode, first.body.slice(0, 300)).toBe(200);

    const firstRouteId = first.json().data.routeId;

    // Blocked between the dialog opening and the dispatcher confirming.
    await prisma.vehicle.update({
      where: { id: TRUCK_2 },
      data: { status: "BLOCKED" },
    });

    const refused = await assign([delivery], MARIA, TRUCK_2);

    await prisma.vehicle.update({
      where: { id: TRUCK_2 },
      data: { status: "ACTIVE" },
    });

    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("ROUTE_VEHICLE_UNAVAILABLE");

    // Before: the 400 came after the detach had committed — João's route had
    // already lost the stop and the document sat unassigned.
    expect(
      await prisma.routeStop.count({ where: { routeId: firstRouteId } }),
      "a rota anterior perdeu a parada",
    ).toBe(1);

    const row = await prisma.delivery.findUniqueOrThrow({
      where: { id: delivery },
    });

    expect(row.driverId).toBe(JOAO);
    expect(row.vehicleId).toBe(TRUCK_1);
  });
});

describe("a resend of an assignment that already happened", () => {
  it("answers with the same route and releases it once", async () => {
    const delivery = await seedDelivery("NF-ATOM-2");

    const once = await assign([delivery], JOAO, TRUCK_1);
    const twice = await assign([delivery], JOAO, TRUCK_1);

    expect(once.statusCode).toBe(200);
    expect(twice.statusCode, twice.body.slice(0, 300)).toBe(200);

    expect(twice.json().data.routeId).toBe(once.json().data.routeId);

    const routes = await prisma.route.findMany({
      where: { stops: { some: { deliveryId: delivery } } },
    });

    expect(routes).toHaveLength(1);

    const releases = await prisma.domainOutboxEvent.count({
      where: { topic: "route.released", aggregateId: once.json().data.routeId },
    });

    expect(releases, "motorista avisado duas vezes").toBe(1);
  });
});

describe("the route a reassignment empties", () => {
  it("is cancelled, and a truck out on another route stays out", async () => {
    // João is on the road with truck 3...
    const onTheRoad = await seedDelivery("NF-ATOM-3");

    const out = await assign([onTheRoad], JOAO, TRUCK_3);
    const outRouteId = out.json().data.routeId;

    const departed = await app.inject({
      method: "POST",
      url: `/route/start-route/${outRouteId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: {},
    });

    expect(departed.statusCode, departed.body.slice(0, 300)).toBe(200);

    // ...and tomorrow's route, on the same truck, is already released.
    const tomorrow = await seedDelivery("NF-ATOM-4");

    const released = await assign([tomorrow], JOAO, TRUCK_3);
    const releasedRouteId = released.json().data.routeId;

    const moved = await assign([tomorrow], MARIA, TRUCK_4);

    expect(moved.statusCode, moved.body.slice(0, 300)).toBe(200);

    const emptied = await prisma.route.findUniqueOrThrow({
      where: { id: releasedRouteId },
    });

    // Before: RELEASED with zero stops, forever.
    expect(emptied.status).toBe("CANCELLED");

    // Before: cancelling any route moved its truck IN_ROUTE → ACTIVE, even
    // one that never left — so the truck on the road read as free.
    const truck = await prisma.vehicle.findUniqueOrThrow({
      where: { id: TRUCK_3 },
    });

    expect(truck.status, "caminhão na rua marcado como livre").toBe("IN_ROUTE");
  });
});
