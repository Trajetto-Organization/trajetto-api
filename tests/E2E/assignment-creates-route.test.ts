import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * The batch assignment, over real HTTP, now that it builds a route.
 *
 * The unit file next door wires the real `create-route` and `release-route`
 * into the use case and proves the delegation. This one proves two things it
 * cannot: that the CONTAINER can build the use case at all — it gained two
 * use-case dependencies, and a missing registration is a 500 that no unit
 * test would see — and that a day dispatched this way is trackable, which is
 * the whole reason the change was made.
 *
 * Trackability is asserted through the endpoint the phone actually calls.
 * `/route/positions` answers `tracking: false` and stores nothing unless the
 * driver has a route IN_PROGRESS; before this change a batch assignment
 * created no route, so every position a driver's phone sent for that day was
 * discarded and the trail — the thing a dispute is settled with — did not
 * exist. No test anywhere failed over it.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fd400-0000-7000-8000-00000000000a";

const DISPATCHER = "018fd400-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018fd400-0000-7000-8000-0000000000a2";

const DRIVER = "018fd400-0000-7000-8000-0000000000d1";
const VEHICLE = "018fd400-0000-7000-8000-0000000000c1";
const OTHER_VEHICLE = "018fd400-0000-7000-8000-0000000000c2";

/**
 * A third truck, because a departure OCCUPIES one: the database refuses a
 * second route in progress on the same vehicle, which is the right rule and
 * would otherwise make the last scenario fail for a reason it is not about.
 */
const THIRD_VEHICLE = "018fd400-0000-7000-8000-0000000000c3";

const SHIPPER = "018fd400-0000-7000-8000-0000000000f1";

let dispatcherToken = "";
let driverToken = "";

let profileId = "";
let vehicleTypeId = "";
let fuelTypeId = "";

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

const asDispatcher = () => ({ authorization: `Bearer ${dispatcherToken}` });
const asDriver = () => ({ authorization: `Bearer ${driverToken}` });

async function assign(
  deliveryIds: string[],
  vehicleId: string | null = VEHICLE,
) {
  return app.inject({
    method: "PATCH",
    url: `/delivery/assign-deliveries/${CARRIER}`,
    headers: asDispatcher(),
    payload: {
      deliveryIds,
      driverId: DRIVER,
      ...(vehicleId ? { vehicleId } : {}),
    },
  });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Designação",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(60000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `designacao-${randomUUID()}@exemplo.com.br`,
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

  profileId = profile.id;

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista da Designação",
      birth_date: new Date("1990-01-01"),
      cnh: `CNH${randomUUID().slice(0, 8)}`,
      cpf: String(Date.now()).slice(-11),
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

  vehicleTypeId = vehicleType.id;

  const fuelType = await prisma.fuelType.create({
    data: { description: `Diesel ${randomUUID().slice(0, 6)}`, businessId: CARRIER },
  });

  fuelTypeId = fuelType.id;

  for (const [id, plate] of [
    [VEHICLE, "AAA1B22"],
    [OTHER_VEHICLE, "CCC3D44"],
    [THIRD_VEHICLE, "EEE5F66"],
  ] as const) {
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
        renavam: String(
          Date.now() + (id === VEHICLE ? 0 : id === OTHER_VEHICLE ? 1 : 2),
        ).slice(-11),
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
        name: "Motorista",
        email: `motorista-${randomUUID()}@exemplo.com.br`,
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
  await prisma.driverPosition.deleteMany({ where: { driverId: DRIVER } });

  await prisma.routeStop.deleteMany({ where: { route: { businessId: CARRIER } } });
  await prisma.route.deleteMany({ where: { businessId: CARRIER } });

  await prisma.delivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.shipper.deleteMany({ where: { id: SHIPPER } });

  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [DISPATCHER, DRIVER_USER] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [DISPATCHER, DRIVER_USER] } },
  });

  await prisma.vehicle.deleteMany({ where: { businessId: CARRIER } });
  await prisma.vehicleType.deleteMany({ where: { id: vehicleTypeId } });
  await prisma.fuelType.deleteMany({ where: { id: fuelTypeId } });
  await prisma.driver.deleteMany({ where: { id: DRIVER } });

  await prisma.permission.deleteMany({ where: { profileAccessId: profileId } });
  await prisma.profileAccess.deleteMany({ where: { id: profileId } });

  await prisma.businessEntitlement.deleteMany({
    where: { businessId: CARRIER },
  });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

describe("assigning a batch", () => {
  it("answers with the route it created", async () => {
    const first = await seedDelivery("NF-1001");
    const second = await seedDelivery("NF-1002");

    const response = await assign([first, second]);

    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);

    const body = response.json();

    expect(body.data.assigned).toBe(2);
    expect(body.data.routeId).toBeTruthy();
    expect(typeof body.data.routeCode).toBe("number");

    const route = await prisma.route.findUnique({
      where: { id: body.data.routeId },
      include: { stops: true },
    });

    expect(route, "a designação não criou rota").not.toBeNull();
    expect(route!.status).toBe("RELEASED");
    expect(route!.stops).toHaveLength(2);
    expect(route!.driverId).toBe(DRIVER);
    expect(route!.vehicleId).toBe(VEHICLE);
  });

  it("refuses without a vehicle, before writing anything", async () => {
    const delivery = await seedDelivery("NF-1003");

    const response = await assign([delivery], null);

    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    const stored = await prisma.delivery.findUnique({
      where: { id: delivery },
    });

    expect(stored!.driverId).toBeNull();
  });
});

describe("the day is trackable, which is the point", () => {
  it("records positions once the driver starts the route the assignment made", async () => {
    const delivery = await seedDelivery("NF-2001");

    const assigned = await assign([delivery]);

    expect(assigned.statusCode, assigned.body.slice(0, 400)).toBe(200);

    const routeId = assigned.json().data.routeId;

    /**
     * Before the route exists there is nothing to start, and this is exactly
     * what the old shortcut produced: a driver with work on the phone and an
     * ingest endpoint answering `tracking: false` all day.
     */
    const beforeDeparture = await app.inject({
      method: "POST",
      url: "/route/positions",
      headers: asDriver(),
      payload: {
        businessId: CARRIER,
        pings: [
          {
            latitude: -23.55,
            longitude: -46.63,
            recorded_at: new Date().toISOString(),
          },
        ],
      },
    });

    expect(beforeDeparture.statusCode).toBe(200);
    expect(beforeDeparture.json().data.tracking).toBe(false);

    const started = await app.inject({
      method: "POST",
      url: `/route/start-route/${routeId}/business/${CARRIER}`,
      headers: asDriver(),
      payload: {},
    });

    expect(started.statusCode, started.body.slice(0, 300)).toBe(200);

    const afterDeparture = await app.inject({
      method: "POST",
      url: "/route/positions",
      headers: asDriver(),
      payload: {
        businessId: CARRIER,
        pings: [
          {
            latitude: -23.55,
            longitude: -46.63,
            recorded_at: new Date().toISOString(),
          },
        ],
      },
    });

    expect(afterDeparture.statusCode).toBe(200);

    const body = afterDeparture.json().data;

    expect(body.tracking, "a rota criada pela designação não rastreia").toBe(
      true,
    );
    expect(body.stored).toBe(1);
  });
});

describe("reassigning", () => {
  it("moves the delivery to a new route while the first has not left", async () => {
    const delivery = await seedDelivery("NF-3001");

    const first = await assign([delivery]);
    const firstRouteId = first.json().data.routeId;

    const second = await assign([delivery], OTHER_VEHICLE);

    expect(second.statusCode, second.body.slice(0, 300)).toBe(200);

    const secondRouteId = second.json().data.routeId;

    expect(secondRouteId).not.toBe(firstRouteId);

    // A delivery may hold only one open stop at a time, and the database is
    // what enforces it: the first route gives its stop up.
    const abandoned = await prisma.routeStop.count({
      where: { routeId: firstRouteId },
    });

    expect(abandoned).toBe(0);

    const stored = await prisma.delivery.findUnique({
      where: { id: delivery },
    });

    expect(stored!.vehicleId).toBe(OTHER_VEHICLE);
  });

  it("refuses once the route has left, naming the document", async () => {
    const delivery = await seedDelivery("NF-3002");

    // Its own truck: the one used earlier is already out on another route.
    const first = await assign([delivery], THIRD_VEHICLE);
    const routeId = first.json().data.routeId;

    const departed = await app.inject({
      method: "POST",
      url: `/route/start-route/${routeId}/business/${CARRIER}`,
      headers: asDriver(),
      payload: {},
    });

    // Asserted, because the refusal below is only meaningful if the route
    // really left: a start that silently failed would leave it RELEASED and
    // the reassignment would be legal for the right reason.
    expect(departed.statusCode, departed.body.slice(0, 300)).toBe(200);

    const second = await assign([delivery], OTHER_VEHICLE);

    expect(second.statusCode).toBe(409);
    expect(second.body).toContain("NF-3002");

    // And the route that left keeps its stop: the driver does not find the
    // delivery gone from the phone mid-street.
    const kept = await prisma.routeStop.count({ where: { routeId } });

    expect(kept).toBe(1);
  });
});
