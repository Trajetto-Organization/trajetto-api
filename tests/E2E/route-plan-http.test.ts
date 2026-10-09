import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

import { RouteRepository } from "@/modules/route/repositories/route-repository";

/**
 * The route's plan, search and departure over real HTTP and a real Postgres:
 * decisions 1.3/1.4/6.5 (the day is a date, the times carry an offset, the
 * window is read in the company's zone, the destination is stored and
 * served), TEST-ROUTE-1 (a long number in the search box), FLEET-ASSIGN-3 (one
 * route on the street per driver, under a lock), the assignment's plan and
 * the assignment preview with its tenant and role guards.
 *
 * What the unit suite cannot show lives here: the Int column Prisma refuses,
 * the per-driver lock two concurrent departures race through, the response
 * serializer that drops a field nobody documented, and the guards as wired.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER_A = "018f2000-0000-7000-8000-00000000000a";
const CARRIER_B = "018f2000-0000-7000-8000-00000000000b";
const CARRIER_OFF = "018f2000-0000-7000-8000-00000000000c";

const JOAO = "018f2000-0000-7000-8000-0000000000d1";
const MARIA = "018f2000-0000-7000-8000-0000000000d2";
const DRIVER_B = "018f2000-0000-7000-8000-0000000000d9";

const TRUCK_JOAO = "018f2000-0000-7000-8000-0000000000e1";
const TRUCK_MARIA = "018f2000-0000-7000-8000-0000000000e2";
const TRUCK_FREE = "018f2000-0000-7000-8000-0000000000e3";
const TRUCK_B = "018f2000-0000-7000-8000-0000000000e9";

const SHIPPER_A = "018f2000-0000-7000-8000-0000000000f1";

let dispatcherA: string;
let dispatcherB: string;
let readOnlyA: string;
let driverJoao: string;
let dispatcherOff: string;

let cnpjSeq = 0;
let deliverySeq = 0;

async function seedBusiness(id: string, withDeliveries = true): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: String(11222333000280 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  if (withDeliveries) {
    await prisma.businessEntitlement.create({
      data: { businessId: id, module: "DELIVERIES", enabled: true },
    });
  }
}

async function seedUser(
  businessId: string,
  role: "BUSINESS_ADMIN" | "BUSINESS_USER",
  options: { driverId?: string; profileAccessId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Usuário",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      driverId: options.driverId ?? null,
      profileAccessId: options.profileAccessId ?? null,
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

async function seedDriver(businessId: string, id: string, name: string): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name,
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
      businessId,
    },
  });
}

async function seedVehicle(
  businessId: string,
  id: string,
  plate: string,
  driverId: string | null,
): Promise<void> {
  await prisma.vehicle.create({
    data: {
      id,
      description: `Caminhão ${plate}`,
      license_plate: plate,
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `renavam-${id}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId,
      fuelTypeId: `ft-${businessId}`,
      driverId,
    },
  });
}

async function seedDelivery(): Promise<string> {
  deliverySeq += 1;

  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: `Cliente ${deliverySeq}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER_A,
      shipperId: SHIPPER_A,
    },
  });

  return delivery.id;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  await seedBusiness(CARRIER_A);
  await seedBusiness(CARRIER_B);
  await seedBusiness(CARRIER_OFF, false);

  // A has Frotas as well, so the preview reads its fleet's facts; B has
  // Entregas only (the preview's module-gate case).
  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER_A, module: "FLEET", enabled: true },
  });

  for (const businessId of [CARRIER_A, CARRIER_B]) {
    await prisma.fuelType.create({
      data: { id: `ft-${businessId}`, description: "Diesel", businessId },
    });
  }

  await seedDriver(CARRIER_A, JOAO, "João");
  await seedDriver(CARRIER_A, MARIA, "Maria");
  await seedDriver(CARRIER_B, DRIVER_B, "Motorista B");

  await seedVehicle(CARRIER_A, TRUCK_JOAO, "JOA1A11", JOAO);
  await seedVehicle(CARRIER_A, TRUCK_MARIA, "MAR2B22", MARIA);
  await seedVehicle(CARRIER_A, TRUCK_FREE, "LIV3C33", null);
  await seedVehicle(CARRIER_B, TRUCK_B, "BBB4D44", DRIVER_B);

  await prisma.shipper.create({
    data: { id: SHIPPER_A, name: "Embarcador", businessId: CARRIER_A },
  });

  const readOnly = await prisma.profileAccess.create({
    data: {
      name: "Só leitura",
      businessId: CARRIER_A,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: "Gerenciar entregas",
            canRead: true,
            canWrite: false,
            businessId: CARRIER_A,
          },
        ],
      },
    },
  });

  dispatcherA = await seedUser(CARRIER_A, "BUSINESS_ADMIN");
  dispatcherB = await seedUser(CARRIER_B, "BUSINESS_ADMIN");
  readOnlyA = await seedUser(CARRIER_A, "BUSINESS_USER", {
    profileAccessId: readOnly.id,
  });
  driverJoao = await seedUser(CARRIER_A, "BUSINESS_USER", { driverId: JOAO });
  dispatcherOff = await seedUser(CARRIER_OFF, "BUSINESS_ADMIN");

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

async function createRoute(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/route/create-route/${CARRIER_A}`,
    headers: bearer(dispatcherA),
    payload: { driverId: JOAO, scheduled_date: "2026-09-17", ...payload },
  });
}

describe("planning a route over HTTP", () => {
  it("refuses a planned time without an offset, in Portuguese", async () => {
    // Red before: z.coerce.date() accepted "2026-09-17T08:00" and read it in
    // the server's zone — three hours off in the UTC container.
    const response = await createRoute({ planned_departure_at: "2026-09-17T08:00" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      issues: [
        "A saída prevista deve ter data, hora e fuso (ex.: 2026-09-17T08:00:00-03:00).",
      ],
    });
  });

  it("stores the day, the exact instants and the destination, and serves them back", async () => {
    const response = await createRoute({
      name: "Zona Sul",
      destination: "CD Cajamar",
      planned_departure_at: "2026-09-17T08:00:00-03:00",
      planned_arrival_at: "2026-09-17T18:30:00-03:00",
    });

    expect(response.statusCode, response.body).toBe(201);

    const { id } = response.json().data;

    const detail = await app.inject({
      method: "GET",
      url: `/route/get-route/${id}/business/${CARRIER_A}`,
      headers: bearer(dispatcherA),
    });

    expect(detail.statusCode).toBe(200);

    // Red before: `destination` was dropped by the response schema.
    expect(detail.json().data).toMatchObject({
      destination: "CD Cajamar",
      scheduled_date: "2026-09-17T00:00:00.000Z",
      planned_departure_at: "2026-09-17T11:00:00.000Z",
      planned_arrival_at: "2026-09-17T21:30:00.000Z",
    });
  });

  it("refuses a departure off the route's day in the company's zone", async () => {
    // 23:00 of the 16th in São Paulo is 02:00Z of the 17th: the UTC day
    // matches, the company's does not.
    const response = await createRoute({
      planned_departure_at: "2026-09-17T02:00:00.000Z",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "ROUTE_PLAN_INVALID",
      message: "A saída prevista deve ser no dia da rota.",
    });
  });

  it("judges a partial edit against the stored window", async () => {
    const created = await createRoute({
      planned_departure_at: "2026-09-17T08:00:00-03:00",
    });

    const { id } = created.json().data;

    const moved = await app.inject({
      method: "PATCH",
      url: `/route/update-route/${id}/business/${CARRIER_A}`,
      headers: bearer(dispatcherA),
      payload: { scheduled_date: "2026-09-18" },
    });

    expect(moved.statusCode).toBe(400);
    expect(moved.json().code).toBe("ROUTE_PLAN_INVALID");

    const renamed = await app.inject({
      method: "PATCH",
      url: `/route/update-route/${id}/business/${CARRIER_A}`,
      headers: bearer(dispatcherA),
      payload: { destination: "Zona Leste" },
    });

    expect(renamed.statusCode).toBe(200);
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id } })).destination,
    ).toBe("Zona Leste");
  });

  it("refuses an instant as the route's day", async () => {
    const response = await createRoute({ scheduled_date: "2026-09-17T03:00:00.000Z" });

    expect(response.statusCode).toBe(400);
    expect(response.json().issues).toEqual([
      "A data da rota deve estar no formato AAAA-MM-DD.",
    ]);
  });
});

describe("searching the board (TEST-ROUTE-1)", () => {
  it("answers a pasted NF-e key with an empty page, not a 500", async () => {
    const key = "35240912345678000190550010000012341000012345";

    // Red before: the key reached the INTEGER column as 3.5e43.
    await expect(
      new RouteRepository(prisma).listRoutes({
        businessId: CARRIER_A,
        page: 1,
        pageSize: 10,
        search: key,
      }),
    ).resolves.toMatchObject({ total: 0 });

    const response = await app.inject({
      method: "GET",
      url: `/route/list-routes?businessId=${CARRIER_A}&page=1&pageSize=10&search=${key}`,
      headers: bearer(dispatcherA),
    });

    expect(response.statusCode).toBe(200);
  });

  it("finds a route by what people type for its code", async () => {
    const created = await createRoute({ name: "Sem número no nome" });
    const { code } = created.json().data;

    const found = await new RouteRepository(prisma).listRoutes({
      businessId: CARRIER_A,
      page: 1,
      pageSize: 10,
      search: `Rota ${code}`,
    });

    expect(found.data.map((route) => route.code)).toContain(code);
  });
});

describe("one route on the street per driver (FLEET-ASSIGN-3)", () => {
  async function releasedRouteFor(vehicleId: string): Promise<string> {
    const delivery = await seedDelivery();

    const created = await createRoute({ vehicleId, deliveryIds: [delivery] });

    expect(created.statusCode, created.body).toBe(201);

    const { id } = created.json().data;

    const released = await app.inject({
      method: "PATCH",
      url: `/route/release-route/${id}/business/${CARRIER_A}`,
      headers: bearer(dispatcherA),
      payload: { released: true },
    });

    expect(released.statusCode, released.body).toBe(200);

    return id;
  }

  it("lets exactly one of two concurrent departures leave", async () => {
    // Two released routes of João, on two different trucks, started at the
    // same instant. Red before: both answered 200 and João had two routes
    // in progress; the vehicle index could not see it (two trucks).
    const first = await releasedRouteFor(TRUCK_JOAO);
    const second = await releasedRouteFor(TRUCK_FREE);

    const depart = (routeId: string) =>
      app.inject({
        method: "POST",
        url: `/route/start-route/${routeId}/business/${CARRIER_A}`,
        headers: bearer(driverJoao),
        payload: {},
      });

    const answers = await Promise.all([depart(first), depart(second)]);

    const statuses = answers.map((answer) => answer.statusCode).sort();

    expect(statuses).toEqual([200, 409]);

    const refused = answers.find((answer) => answer.statusCode === 409)!;

    expect(refused.json().code).toBe("ROUTE_DRIVER_BUSY");
    expect(refused.json().message).toMatch(/^Você já está com a Rota \d+ em andamento\./);

    expect(
      await prisma.route.count({
        where: { businessId: CARRIER_A, driverId: JOAO, status: "IN_PROGRESS" },
      }),
    ).toBe(1);

    // Leave the stage clean for the tests below: the running one ends.
    await prisma.route.updateMany({
      where: { driverId: JOAO, status: "IN_PROGRESS" },
      data: { status: "CANCELLED" },
    });
    await prisma.vehicle.updateMany({
      where: { businessId: CARRIER_A },
      data: { status: "ACTIVE" },
    });
    await prisma.route.updateMany({
      where: { driverId: JOAO, status: "RELEASED" },
      data: { status: "CANCELLED" },
    });
  });
});

describe("a driver deactivated while a route is being written (decision 8.3)", () => {
  /**
   * The deactivation as the driver module runs it: the driver row FOR UPDATE,
   * the status changed, the commit held until the route request is already
   * waiting. The route write read ACTIVE before its transaction; only a
   * re-read under the row's lock sees the commit.
   */
  async function deactivateWhile(
    driverId: string,
    request: () => Promise<{ statusCode: number; body: string; json: () => any }>,
  ) {
    let locked!: () => void;
    let release!: () => void;

    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));

    const deactivation = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "driver" WHERE "id" = ${driverId} FOR UPDATE`;
        await tx.driver.update({ where: { id: driverId }, data: { status: "INACTIVE" } });
        locked();
        await released;
      },
      { timeout: 20_000 },
    );

    await isLocked;

    const pending = request();

    // Long enough for the request to pass its early checks and block.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    release();

    await deactivation;

    return pending;
  }

  it("does not create a route for a driver deactivated in between", async () => {
    const pedro = randomUUID();

    await seedDriver(CARRIER_A, pedro, "Pedro");

    const before = await prisma.route.count({ where: { driverId: pedro } });

    const response = await deactivateWhile(pedro, () =>
      app.inject({
        method: "POST",
        url: `/route/create-route/${CARRIER_A}`,
        headers: bearer(dispatcherA),
        payload: { driverId: pedro, scheduled_date: "2026-09-26" },
      }),
    );

    // Red before: the FK check waited for the commit and let the route in.
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("ROUTE_DRIVER_INACTIVE");
    expect(await prisma.route.count({ where: { driverId: pedro } })).toBe(before);
  }, 30_000);

  it("does not release a route to a driver deactivated in between", async () => {
    const paula = randomUUID();

    await seedDriver(CARRIER_A, paula, "Paula");

    const delivery = await seedDelivery();

    const created = await app.inject({
      method: "POST",
      url: `/route/create-route/${CARRIER_A}`,
      headers: bearer(dispatcherA),
      payload: {
        driverId: paula,
        vehicleId: TRUCK_FREE,
        scheduled_date: "2026-09-26",
        deliveryIds: [delivery],
      },
    });

    expect(created.statusCode, created.body).toBe(201);

    const { id } = created.json().data;

    const response = await deactivateWhile(paula, () =>
      app.inject({
        method: "PATCH",
        url: `/route/release-route/${id}/business/${CARRIER_A}`,
        headers: bearer(dispatcherA),
        payload: { released: true },
      }),
    );

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("ROUTE_NOT_RELEASABLE");
    expect((await prisma.route.findUniqueOrThrow({ where: { id } })).status).toBe("PLANNED");
  }, 30_000);
});

describe("which route is 'the' driver's route on a same-day tie", () => {
  it("answers the oldest row, in both reads, whatever the heap order", async () => {
    // `scheduled_date` is a date now, so two routes of a day always tie on
    // it. The NEWER row is inserted first. Red before: both queries ordered
    // by the day alone and Postgres answered the first row it met.
    const ANA = "018f2000-0000-7000-8000-0000000000d3";

    await seedDriver(CARRIER_A, ANA, "Ana");

    const day = new Date("2026-09-25T00:00:00.000Z");

    const newer = await prisma.route.create({
      data: {
        code: 900,
        scheduled_date: day,
        status: "IN_PROGRESS",
        started_at: new Date("2026-09-25T12:00:00.000Z"),
        businessId: CARRIER_A,
        driverId: ANA,
        created_at: new Date("2026-09-25T11:00:00.000Z"),
      },
    });

    const older = await prisma.route.create({
      data: {
        code: 901,
        scheduled_date: day,
        status: "IN_PROGRESS",
        started_at: new Date("2026-09-25T10:00:00.000Z"),
        businessId: CARRIER_A,
        driverId: ANA,
        created_at: new Date("2026-09-25T09:00:00.000Z"),
      },
    });

    const repository = new RouteRepository(prisma);

    expect((await repository.findDriverRoute(CARRIER_A, ANA))?.id).toBe(older.id);
    expect((await repository.findActiveRouteForDriver(CARRIER_A, ANA))?.id).toBe(
      older.id,
    );

    await prisma.route.updateMany({
      where: { id: { in: [newer.id, older.id] } },
      data: { status: "CANCELLED" },
    });
  });
});

describe("the batch assignment's plan", () => {
  it("creates the released route with the day, destination and window it was given", async () => {
    const delivery = await seedDelivery();

    const response = await app.inject({
      method: "PATCH",
      url: `/delivery/assign-deliveries/${CARRIER_A}`,
      headers: bearer(dispatcherA),
      payload: {
        deliveryIds: [delivery],
        driverId: MARIA,
        vehicleId: TRUCK_MARIA,
        scheduled_date: "2026-09-20",
        destination: "Zona Leste",
        planned_departure_at: "2026-09-20T07:30:00-03:00",
        planned_arrival_at: "2026-09-20T17:00:00-03:00",
      },
    });

    expect(response.statusCode, response.body).toBe(200);

    const route = await prisma.route.findUniqueOrThrow({
      where: { id: response.json().data.routeId },
    });

    // Red before: all four were dropped and the day was the server's today.
    expect(route).toMatchObject({
      status: "RELEASED",
      destination: "Zona Leste",
    });
    expect(route.scheduled_date.toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(route.planned_departure_at?.toISOString()).toBe("2026-09-20T10:30:00.000Z");
    expect(route.planned_arrival_at?.toISOString()).toBe("2026-09-20T20:00:00.000Z");
  });

  it("refuses a return before the departure, writing nothing", async () => {
    const delivery = await seedDelivery();
    const before = await prisma.route.count();

    const response = await app.inject({
      method: "PATCH",
      url: `/delivery/assign-deliveries/${CARRIER_A}`,
      headers: bearer(dispatcherA),
      payload: {
        deliveryIds: [delivery],
        driverId: MARIA,
        vehicleId: TRUCK_MARIA,
        scheduled_date: "2026-09-21",
        planned_departure_at: "2026-09-21T17:00:00-03:00",
        planned_arrival_at: "2026-09-21T08:00:00-03:00",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().issues).toEqual([
      "O retorno previsto deve ser igual ou posterior à saída prevista.",
    ]);
    expect(await prisma.route.count()).toBe(before);
  });

  it("applies a corrected plan to the route it already released for the same selection", async () => {
    const delivery = await seedDelivery();

    const assign = (plan: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: `/delivery/assign-deliveries/${CARRIER_A}`,
        headers: bearer(dispatcherA),
        payload: {
          deliveryIds: [delivery],
          driverId: MARIA,
          vehicleId: TRUCK_MARIA,
          scheduled_date: "2026-09-22",
          ...plan,
        },
      });

    const first = await assign({ destination: "Zona Leste" });

    expect(first.statusCode, first.body).toBe(200);

    const code = first.json().data.routeCode;

    expect(first.json().message).toBe(`Rota ${code} criada e liberada com 1 entrega.`);

    // The lost-answer resend: same selection, pair and plan. Red before: it
    // also said "criada e liberada", over a route it neither created nor
    // released.
    const resent = await assign({ destination: "Zona Leste" });

    expect(resent.statusCode, resent.body).toBe(200);
    expect(resent.json().message).toBe(
      `Rota ${code} já estava criada e liberada com 1 entrega; nada foi alterado.`,
    );

    const before = await prisma.route.count();

    // The container wires the edit path too (update-route, by @inject).
    const corrected = await assign({
      destination: "CD Cajamar",
      planned_departure_at: "2026-09-22T06:45:00-03:00",
    });

    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(corrected.json().data.routeId).toBe(first.json().data.routeId);
    expect(corrected.json().message).toBe(
      `Rota ${code} atualizada com o novo planejamento (1 entrega).`,
    );
    expect(await prisma.route.count()).toBe(before);

    const route = await prisma.route.findUniqueOrThrow({
      where: { id: first.json().data.routeId },
    });

    // Red before: the resend answered 200 and kept "Zona Leste", no time.
    expect(route.status).toBe("RELEASED");
    expect(route.destination).toBe("CD Cajamar");
    expect(route.planned_departure_at?.toISOString()).toBe("2026-09-22T09:45:00.000Z");
  });
});

describe("the assignment preview", () => {
  const preview = (token: string, query: string, businessId = CARRIER_A) =>
    app.inject({
      method: "GET",
      url: `/route/assignment-preview/${businessId}?${query}`,
      headers: bearer(token),
    });

  it("suggests the driver's own truck and names another driver's", async () => {
    const own = await preview(dispatcherA, `driverId=${JOAO}&scheduled_date=2026-09-30`);

    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().data).toMatchObject({
      scheduled_date: "2026-09-30",
      driver: { id: JOAO, name: "João" },
      suggestedVehicleId: TRUCK_JOAO,
      warnings: [],
    });

    const other = await preview(
      dispatcherA,
      `driverId=${JOAO}&vehicleId=${TRUCK_MARIA}&scheduled_date=2026-09-30`,
    );

    expect(other.json().data.vehicle).toMatchObject({
      license_plate: "MAR2B22",
      responsible: { id: MARIA, name: "Maria" },
    });
    expect(other.json().data.warnings).toEqual([
      {
        code: "VEHICLE_OTHER_RESPONSIBLE",
        message:
          "O responsável pelo veículo MAR2B22 é Maria. A atribuição continua permitida.",
      },
    ]);
  });

  it("warns about the CNH, open service orders and a rejected last checklist (8.5)", async () => {
    // The free truck is a "Truck" type that asks for category C; Maria holds
    // a B that expired before the route's day.
    const type = await prisma.vehicleType.create({
      data: {
        description: "Truck",
        number_of_axles: 3,
        required_cnh_category: "C",
        businessId: CARRIER_A,
      },
    });

    await prisma.vehicle.update({
      where: { id: TRUCK_FREE },
      data: { vehicleTypeId: type.id },
    });

    await prisma.driver.update({
      where: { id: MARIA },
      data: { cnh_category: "B", cnh_expires_at: new Date("2026-09-01") },
    });

    const mechanic = await prisma.user.create({
      data: {
        name: "Mecânico",
        email: `${randomUUID()}@exemplo.com.br`,
        password: "not-used-here",
        role: "BUSINESS_USER",
        businessId: CARRIER_A,
      },
    });

    const branch = await prisma.branch.create({
      data: {
        corporate_reason: "Filial Centro",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        cnpj: "61222333000155",
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `filial-${randomUUID()}@exemplo.com.br`,
        businessId: CARRIER_A,
      },
    });

    const order = (date: string, completed: boolean) =>
      prisma.serviceOrder.create({
        data: {
          date: new Date(date),
          completion_date: completed ? new Date(date) : null,
          maintenance_type: "INTERNAL",
          total_amount: 100,
          businessId: CARRIER_A,
          vehicleId: TRUCK_FREE,
          branchId: branch.id,
          responsibleUserId: mechanic.id,
        },
      });

    await order("2026-09-01T12:00:00.000Z", true);
    // 01:30Z of the 11th is the 10th in the company's zone (São Paulo).
    await order("2026-09-11T01:30:00.000Z", false);

    const checklist = (date: string, overall: string) =>
      prisma.vehicleChecklist.create({
        data: {
          checklist_date: new Date(date),
          current_mileage: 1000,
          tires_condition: "good",
          bumpers_condition: "good",
          windshield_condition: "good",
          mirrors_condition: "good",
          steering_wheel_condition: "good",
          battery_condition: "good",
          spare_tire_condition: "good",
          overall_condition: overall,
          businessId: CARRIER_A,
          branchId: branch.id,
          vehicleId: TRUCK_FREE,
          driverId: MARIA,
        },
      });

    await checklist("2026-09-14T12:00:00.000Z", "approved");
    await checklist("2026-09-16T12:00:00.000Z", "rejected");

    const response = await preview(
      dispatcherA,
      `driverId=${MARIA}&vehicleId=${TRUCK_FREE}&scheduled_date=2026-09-17`,
    );

    expect(response.statusCode, response.body).toBe(200);

    const { data } = response.json();

    expect(data.timeZone).toBe("America/Sao_Paulo");
    expect(data.warnings).toEqual([
      { code: "DRIVER_CNH_EXPIRED", message: "A CNH de Maria venceu em 01/09/2026." },
      {
        code: "DRIVER_CNH_INCOMPATIBLE",
        message: "O veículo LIV3C33 exige CNH categoria C, e a CNH de Maria é categoria B.",
      },
      {
        code: "VEHICLE_OPEN_SERVICE_ORDER",
        message: "O veículo LIV3C33 tem 1 ordem de serviço aberta desde 10/09/2026.",
      },
      {
        code: "VEHICLE_CHECKLIST_REJECTED",
        message: "O último checklist do veículo LIV3C33, de 16/09/2026, foi reprovado.",
      },
    ]);

    // Only what the choice needs (decision 4.7): no CNH data in the answer.
    expect(response.body).not.toContain("cnh_");
    expect(response.body).not.toContain("openServiceOrders");

    // Put Maria back for the other cases of the file.
    await prisma.driver.update({
      where: { id: MARIA },
      data: { cnh_category: null, cnh_expires_at: null },
    });
  });

  it("leaves the fleet's own facts out for a company without Frotas (decision 4.3)", async () => {
    // B hired Entregas only, but its truck has an open service order and a
    // rejected checklist from when it had Frotas.
    const mechanic = await prisma.user.create({
      data: {
        name: "Mecânico B",
        email: `${randomUUID()}@exemplo.com.br`,
        password: "not-used-here",
        role: "BUSINESS_USER",
        businessId: CARRIER_B,
      },
    });

    const branch = await prisma.branch.create({
      data: {
        corporate_reason: "Filial B",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        cnpj: "61222333000236",
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `filial-b-${randomUUID()}@exemplo.com.br`,
        businessId: CARRIER_B,
      },
    });

    await prisma.serviceOrder.create({
      data: {
        date: new Date("2026-09-10T12:00:00.000Z"),
        maintenance_type: "INTERNAL",
        total_amount: 100,
        businessId: CARRIER_B,
        vehicleId: TRUCK_B,
        branchId: branch.id,
        responsibleUserId: mechanic.id,
      },
    });

    await prisma.vehicleChecklist.create({
      data: {
        checklist_date: new Date("2026-09-16T12:00:00.000Z"),
        current_mileage: 1000,
        tires_condition: "good",
        bumpers_condition: "good",
        windshield_condition: "good",
        mirrors_condition: "good",
        steering_wheel_condition: "good",
        battery_condition: "good",
        spare_tire_condition: "good",
        overall_condition: "rejected",
        businessId: CARRIER_B,
        branchId: branch.id,
        vehicleId: TRUCK_B,
        driverId: DRIVER_B,
      },
    });

    const query = `driverId=${DRIVER_B}&vehicleId=${TRUCK_B}&scheduled_date=2026-09-17`;

    // Red before: both warnings, read whatever modules B has.
    const withoutFleet = await preview(dispatcherB, query, CARRIER_B);

    expect(withoutFleet.statusCode, withoutFleet.body).toBe(200);
    expect(withoutFleet.json().data.warnings).toEqual([]);

    // The same truck once B has Frotas: the facts were there all along.
    const fleet = await prisma.businessEntitlement.create({
      data: { businessId: CARRIER_B, module: "FLEET", enabled: true },
    });

    const withFleet = await preview(dispatcherB, query, CARRIER_B);

    expect(
      withFleet.json().data.warnings.map((warning: { code: string }) => warning.code),
    ).toEqual(["VEHICLE_OPEN_SERVICE_ORDER", "VEHICLE_CHECKLIST_REJECTED"]);

    // Switched off again (hired, then disabled): no warnings either.
    await prisma.businessEntitlement.update({
      where: { id: fleet.id },
      data: { enabled: false },
    });

    const switchedOff = await preview(dispatcherB, query, CARRIER_B);

    expect(switchedOff.json().data.warnings).toEqual([]);

    await prisma.businessEntitlement.delete({ where: { id: fleet.id } });
  });

  it("does not warn about the released route the selection is leaving", async () => {
    const delivery = await seedDelivery();

    const assigned = await app.inject({
      method: "PATCH",
      url: `/delivery/assign-deliveries/${CARRIER_A}`,
      headers: bearer(dispatcherA),
      payload: {
        deliveryIds: [delivery],
        driverId: JOAO,
        vehicleId: TRUCK_JOAO,
        scheduled_date: "2026-09-25",
      },
    });

    expect(assigned.statusCode, assigned.body).toBe(200);

    const code = assigned.json().data.routeCode;
    const query = `driverId=${JOAO}&vehicleId=${TRUCK_JOAO}&scheduled_date=2026-09-25`;

    const plain = await preview(dispatcherA, query);

    expect(plain.json().data.warnings.map((w: { message: string }) => w.message)).toEqual([
      `João já tem a Rota ${code} para este dia.`,
    ]);

    // Red before: the dialog sent no selection and warned about this route.
    const leaving = await preview(dispatcherA, `${query}&deliveryIds=${delivery}`);

    expect(leaving.statusCode, leaving.body).toBe(200);
    expect(leaving.json().data.warnings).toEqual([]);

    expect((await preview(dispatcherA, `${query}&deliveryIds=abc`)).statusCode).toBe(400);
  });

  it("reads another company's driver or vehicle as absent", async () => {
    const driver = await preview(dispatcherA, `driverId=${DRIVER_B}`);

    expect(driver.statusCode).toBe(404);
    expect(driver.json().code).toBe("DRIVER_NOT_FOUND");

    const vehicle = await preview(dispatcherA, `driverId=${JOAO}&vehicleId=${TRUCK_B}`);

    expect(vehicle.statusCode).toBe(404);
    expect(vehicle.json().code).toBe("VEHICLE_NOT_FOUND");
  });

  it("refuses another company's dispatcher, a driver, a read-only user and a company without the module", async () => {
    const crossTenant = await preview(dispatcherB, `driverId=${JOAO}`);

    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.json().code).toBe("TENANT_ACCESS_DENIED");

    const asDriver = await preview(driverJoao, `driverId=${JOAO}`);

    expect(asDriver.statusCode).toBe(403);
    expect(asDriver.json().code).toBe("DRIVER_CANNOT_MANAGE_DELIVERIES");

    const readOnly = await preview(readOnlyA, `driverId=${JOAO}`);

    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().code).toBe("PERMISSION_DENIED");

    const noModule = await preview(dispatcherOff, `driverId=${JOAO}`, CARRIER_OFF);

    expect(noModule.statusCode).toBe(403);
    expect(noModule.json().code).toBe("MODULE_NOT_ENABLED");
  });
});
