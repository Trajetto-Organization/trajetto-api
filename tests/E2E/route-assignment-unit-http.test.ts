import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

import { OperationDayRepository } from "@/modules/route/repositories/operation-day-repository";
import { PLANNING_TIMELINE_EVENTS_ENABLED } from "@/modules/route/usecases/shared/route-plan-rules";
import { operationDay } from "@/shared/route/operation-day-rules";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The route as the unit of assignment (decision 14.7) over real HTTP and a
 * real Postgres: what only the database proves.
 *
 * - the plan version under the row lock: two reorders that read the same
 *   version — one wins, the other is told (D5);
 * - the 200-stop ceiling counted under the lock by two concurrent adds (D11);
 * - the move across two routes and its mirror image at the same time, with
 *   no deadlock and never two open stops for one delivery (D10, §8);
 * - the picker's anti-join on the partial unique index (D3);
 * - the Idempotency-Key unique per company (§4.7);
 * - the timeline lines, the released_at stamp, the tower feed that skips the
 *   planning lines, the response serializer that would drop an undocumented
 *   field, and the guards as wired: another company, a read-only profile and
 *   a driver token.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER_A = "018f7e70-0000-7000-8000-00000000000a";
const CARRIER_B = "018f7e70-0000-7000-8000-00000000000b";

const JOAO = "018f7e70-0000-7000-8000-0000000000d1";
const MARIA = "018f7e70-0000-7000-8000-0000000000d2";
const DRIVER_B = "018f7e70-0000-7000-8000-0000000000d9";

const TRUCK_JOAO = "018f7e70-0000-7000-8000-0000000000e1";
const TRUCK_MARIA = "018f7e70-0000-7000-8000-0000000000e2";
const TRUCK_B = "018f7e70-0000-7000-8000-0000000000e9";

const SHIPPER_A = "018f7e70-0000-7000-8000-0000000000f1";
const SHIPPER_B = "018f7e70-0000-7000-8000-0000000000f9";

let dispatcherA: string;
let dispatcherB: string;
let readOnlyA: string;
let driverJoao: string;

let cnpjSeq = 0;
let deliverySeq = 0;

async function seedBusiness(id: string): Promise<void> {
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

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
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

async function seedDriver(
  businessId: string,
  id: string,
  name: string,
): Promise<void> {
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
  driverId: string,
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

async function seedDeliveries(
  count: number,
  extra: { city?: string; businessId?: string; shipperId?: string } = {},
): Promise<string[]> {
  const ids: string[] = [];

  const data = Array.from({ length: count }, () => {
    deliverySeq += 1;

    const id = randomUUID();

    ids.push(id);

    return {
      id,
      code: `E2E-${deliverySeq}`,
      recipient_name: `Cliente ${deliverySeq}`,
      city: extra.city ?? "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: extra.businessId ?? CARRIER_A,
      shipperId:
        extra.shipperId ??
        (extra.businessId === CARRIER_B ? SHIPPER_B : SHIPPER_A),
    };
  });

  await prisma.delivery.createMany({ data });

  return ids;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  await seedBusiness(CARRIER_A);
  await seedBusiness(CARRIER_B);

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
  await seedVehicle(CARRIER_B, TRUCK_B, "BBB4D44", DRIVER_B);

  await prisma.shipper.create({
    data: { id: SHIPPER_A, name: "Embarcador", businessId: CARRIER_A },
  });
  await prisma.shipper.create({
    data: { id: SHIPPER_B, name: "Embarcador B", businessId: CARRIER_B },
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

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

async function createRoute(
  deliveryIds: string[],
  options: {
    driverId?: string;
    vehicleId?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const response = await app.inject({
    method: "POST",
    url: `/route/create-route/${CARRIER_A}`,
    headers: { ...bearer(dispatcherA), ...options.headers },
    payload: {
      driverId: options.driverId ?? JOAO,
      vehicleId: options.vehicleId ?? TRUCK_JOAO,
      scheduled_date: "2026-10-06",
      deliveryIds,
    },
  });

  expect(response.statusCode, response.body.slice(0, 300)).toBe(201);

  return response.json().data as {
    id: string;
    code: number;
    planVersion: number;
  };
}

const call = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  token: string,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method,
    url,
    headers: bearer(token),
    ...(payload && { payload }),
  });

const openStops = (routeId: string) =>
  prisma.routeStop.findMany({
    where: { routeId, status: { in: ["PENDING", "ARRIVED"] } },
    orderBy: { sequence: "asc" },
  });

describe("adding stops (§4.3)", () => {
  it("answers a retry as success, moves the plan once and writes the timeline", async () => {
    const [kept, fresh] = await seedDeliveries(2);
    const route = await createRoute([kept]);

    expect(route.planVersion).toBe(0);

    const first = await call(
      "POST",
      `/route/add-stops/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        deliveryIds: [fresh],
        expectedPlanVersion: 0,
      },
    );

    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().data).toMatchObject({
      added: 1,
      alreadyOnRoute: [],
      planVersion: 1,
    });

    // The resend after a lost answer.
    const retry = await call(
      "POST",
      `/route/add-stops/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        deliveryIds: [fresh],
      },
    );

    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.json().data).toMatchObject({
      added: 0,
      alreadyOnRoute: [fresh],
      planVersion: 1,
    });

    // A stale screen.
    const stale = await call(
      "POST",
      `/route/add-stops/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        deliveryIds: await seedDeliveries(1),
        expectedPlanVersion: 0,
      },
    );

    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("ROUTE_PLAN_STALE");

    const events = await prisma.deliveryEvent.findMany({
      where: { routeId: route.id, type: "ROUTE_ADDED" },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
    });

    // One line per delivery that joined, once — the create's and the add's;
    // neither the retry nor the stale call wrote one. None at all while the
    // gate holds the planning lines back from the trail.
    expect(events.map((event) => [event.deliveryId, event.note])).toEqual(
      PLANNING_TIMELINE_EVENTS_ENABLED
        ? [
            [kept, `Adicionada à Rota ${route.code} (parada 1).`],
            [fresh, `Adicionada à Rota ${route.code} (parada 2).`],
          ]
        : [],
    );

    // The read the page opens carries the version and the address point.
    const detail = await call(
      "GET",
      `/route/get-route/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
    );

    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data).toMatchObject({
      plan_version: 1,
      released_at: null,
      driverPosition: null,
      visitedPoints: [],
    });
    expect(detail.json().data.stops[0].delivery).toHaveProperty(
      "latitude",
      null,
    );
  });

  it("counts the 200-stop ceiling under the lock, against two concurrent adds", async () => {
    const route = await createRoute(await seedDeliveries(100));

    const left = await seedDeliveries(100);
    const right = await seedDeliveries(100);

    const [one, two] = await Promise.all([
      call(
        "POST",
        `/route/add-stops/${route.id}/business/${CARRIER_A}`,
        dispatcherA,
        { deliveryIds: left },
      ),
      call(
        "POST",
        `/route/add-stops/${route.id}/business/${CARRIER_A}`,
        dispatcherA,
        { deliveryIds: right },
      ),
    ]);

    // Both read 100 without the lock; under it, exactly one fits.
    expect([one.statusCode, two.statusCode].sort()).toEqual([201, 400]);
    expect(
      [one, two].find((response) => response.statusCode === 400)!.json().code,
    ).toBe("ROUTE_STOPS_LIMIT");
    expect(await openStops(route.id)).toHaveLength(200);
  }, 60_000);
});

describe("the plan version under concurrency (D5)", () => {
  it("lets one of two reorders that read the same version win", async () => {
    const route = await createRoute(await seedDeliveries(3));
    const ids = (await openStops(route.id)).map((stop) => stop.id);

    const [one, two] = await Promise.all([
      call(
        "PATCH",
        `/route/reorder-stops/${route.id}/business/${CARRIER_A}`,
        dispatcherA,
        {
          orderedStopIds: [...ids].reverse(),
          expectedPlanVersion: 0,
        },
      ),
      call(
        "PATCH",
        `/route/reorder-stops/${route.id}/business/${CARRIER_A}`,
        dispatcherA,
        {
          orderedStopIds: [ids[1], ids[0], ids[2]],
          expectedPlanVersion: 0,
        },
      ),
    ]);

    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);

    const loser = [one, two].find((response) => response.statusCode === 409)!;

    expect(loser.json().code).toBe("ROUTE_PLAN_STALE");
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: route.id } }))
        .plan_version,
    ).toBe(1);

    // The same order again is a no-op: no version.
    const winnerOrder = (await openStops(route.id)).map((stop) => stop.id);
    const again = await call(
      "PATCH",
      `/route/reorder-stops/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        orderedStopIds: winnerOrder,
        expectedPlanVersion: 1,
      },
    );

    expect(again.statusCode).toBe(200);
    expect(again.json().data.planVersion).toBe(1);
  });
});

describe("removing stops in a batch (§4.4)", () => {
  it("removes, reports the gone ones and refuses another company, a read-only profile and a driver", async () => {
    const [first, second] = await seedDeliveries(2);
    const route = await createRoute([first, second]);
    const stopIds = (await openStops(route.id)).map((stop) => stop.id);

    const asB = await call(
      "POST",
      `/route/remove-stops/${route.id}/business/${CARRIER_B}`,
      dispatcherB,
      { stopIds },
    );

    expect(asB.statusCode, asB.body).toBe(404);
    expect(asB.json().code).toBe("DELIVERY_ROUTE_NOT_FOUND");

    const intoA = await call(
      "POST",
      `/route/remove-stops/${route.id}/business/${CARRIER_A}`,
      dispatcherB,
      { stopIds },
    );

    expect(intoA.statusCode).toBe(403);

    const readOnly = await call(
      "POST",
      `/route/remove-stops/${route.id}/business/${CARRIER_A}`,
      readOnlyA,
      { stopIds },
    );

    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().code).toBe("PERMISSION_DENIED");

    const asDriver = await call(
      "POST",
      `/route/remove-stops/${route.id}/business/${CARRIER_A}`,
      driverJoao,
      { stopIds },
    );

    expect(asDriver.statusCode).toBe(403);
    expect(asDriver.json().code).toBe("DRIVER_CANNOT_MANAGE_DELIVERIES");

    // Nothing above wrote anything.
    expect(await openStops(route.id)).toHaveLength(2);

    const removed = await call(
      "POST",
      `/route/remove-stops/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        stopIds: [stopIds[0]],
        expectedPlanVersion: 0,
      },
    );

    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().data).toEqual({
      removed: [stopIds[0]],
      alreadyGone: [],
      planVersion: 1,
      routeEmptied: false,
    });

    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: first },
    });

    expect(delivery.driverId).toBeNull();
    expect(delivery.status).toBe("PENDING");

    const again = await call(
      "POST",
      `/route/remove-stops/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        stopIds,
      },
    );

    expect(again.json().data).toMatchObject({
      removed: [stopIds[1]],
      alreadyGone: [stopIds[0]],
      routeEmptied: true,
    });

    expect(
      await prisma.deliveryEvent.count({
        where: { routeId: route.id, type: "ROUTE_REMOVED" },
      }),
    ).toBe(PLANNING_TIMELINE_EVENTS_ENABLED ? 2 : 0);
  });
});

describe("moving deliveries between routes (D10)", () => {
  it("survives A→B and B→A at the same time, with one open stop per delivery", async () => {
    const left = await seedDeliveries(3);
    const right = await seedDeliveries(3);

    const routeA = await createRoute(left);
    const routeB = await createRoute(right, {
      driverId: MARIA,
      vehicleId: TRUCK_MARIA,
    });

    for (let round = 0; round < 10; round += 1) {
      const [toB, toA] = await Promise.all([
        call(
          "POST",
          `/route/move-stops/${routeB.id}/business/${CARRIER_A}`,
          dispatcherA,
          {
            deliveryIds: [left[round % 3]],
          },
        ),
        call(
          "POST",
          `/route/move-stops/${routeA.id}/business/${CARRIER_A}`,
          dispatcherA,
          {
            deliveryIds: [right[round % 3]],
          },
        ),
      ]);

      // A deadlock would surface as a 500 (40P01) on one of them.
      expect(toB.statusCode, toB.body.slice(0, 300)).toBe(200);
      expect(toA.statusCode, toA.body.slice(0, 300)).toBe(200);
    }

    const all = [...left, ...right];

    const open = await prisma.routeStop.groupBy({
      by: ["deliveryId"],
      where: {
        deliveryId: { in: all },
        status: { in: ["PENDING", "ARRIVED"] },
      },
      _count: { _all: true },
    });

    expect(open).toHaveLength(6);
    expect(open.every((row) => row._count._all === 1)).toBe(true);

    // The shadow follows the route that holds each one.
    const stops = await prisma.routeStop.findMany({
      where: { deliveryId: { in: all }, status: "PENDING" },
      include: { route: true, delivery: true },
    });

    for (const stop of stops) {
      expect(stop.delivery.driverId).toBe(stop.route.driverId);
    }
  }, 60_000);

  it("cancels a released source it empties and refuses one that already left", async () => {
    const [moving] = await seedDeliveries(1);
    const source = await createRoute([moving]);

    const release = await call(
      "PATCH",
      `/route/release-route/${source.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        released: true,
      },
    );

    expect(release.statusCode, release.body).toBe(200);

    const target = await createRoute([], {
      driverId: MARIA,
      vehicleId: TRUCK_MARIA,
    });

    const moved = await call(
      "POST",
      `/route/move-stops/${target.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        deliveryIds: [moving],
      },
    );

    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().data).toMatchObject({
      added: 1,
      moved: [
        {
          deliveryId: moving,
          fromRouteId: source.id,
          fromRouteCode: source.code,
        },
      ],
      cancelledRoutes: [source.code],
    });

    const cancelled = await prisma.route.findUniqueOrThrow({
      where: { id: source.id },
    });

    expect(cancelled.status).toBe("CANCELLED");

    // One that left: the move is refused and nothing changes.
    const [onStreet] = await seedDeliveries(1);
    const running = await createRoute([onStreet]);

    await prisma.route.update({
      where: { id: running.id },
      data: { status: "IN_PROGRESS" },
    });

    const refused = await call(
      "POST",
      `/route/move-stops/${target.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        deliveryIds: [onStreet],
      },
    );

    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("DELIVERY_ON_STARTED_ROUTE");
    expect(await openStops(running.id)).toHaveLength(1);
  });
});

describe("the picker of deliveries without a route (D3)", () => {
  it("lists only PENDING deliveries with no open stop, of the asking company", async () => {
    const [free] = await seedDeliveries(1, { city: "Pirapora do Bom Jesus" });
    const [routed] = await seedDeliveries(1, { city: "Pirapora do Bom Jesus" });
    const [cancelled] = await seedDeliveries(1, {
      city: "Pirapora do Bom Jesus",
    });
    await seedDeliveries(1, {
      city: "Pirapora do Bom Jesus",
      businessId: CARRIER_B,
    });

    await prisma.delivery.update({
      where: { id: cancelled },
      data: { status: "CANCELLED" },
    });
    await createRoute([routed]);

    const page = await call(
      "GET",
      `/route/unrouted-deliveries/${CARRIER_A}?cities=pirapora%20do%20bom%20jesus&pageSize=10`,
      dispatcherA,
    );

    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().data.map((row: { id: string }) => row.id)).toEqual([
      free,
    ]);
    expect(page.json().meta.total).toBe(1);

    const asDriver = await call(
      "GET",
      `/route/unrouted-deliveries/${CARRIER_A}`,
      driverJoao,
    );

    expect(asDriver.statusCode).toBe(403);
    expect(asDriver.json().code).toBe("DRIVER_CANNOT_MANAGE_DELIVERIES");

    const intoA = await call(
      "GET",
      `/route/unrouted-deliveries/${CARRIER_A}`,
      dispatcherB,
    );

    expect(intoA.statusCode).toBe(403);

    const where = await call(
      "GET",
      `/route/open-stops/${CARRIER_B}?deliveryIds=${routed}`,
      dispatcherB,
    );

    expect(where.statusCode).toBe(200);
    expect(where.json().data).toEqual([]);
  });
});

describe("simultaneous creates in one company (route code)", () => {
  // Eight dispatch screens creating a route in the same instant used to read
  // the same highest code: one retry was not enough and some answered 500.
  it("answers 201 to every one, each with its own code", async () => {
    const deliveries = await seedDeliveries(8);

    const answers = await Promise.all(
      deliveries.map((deliveryId, index) =>
        app.inject({
          method: "POST",
          url: `/route/create-route/${CARRIER_A}`,
          headers: bearer(dispatcherA),
          payload: {
            driverId: index % 2 === 0 ? JOAO : MARIA,
            scheduled_date: "2026-10-06",
            deliveryIds: [deliveryId],
          },
        }),
      ),
    );

    for (const answer of answers) {
      expect(answer.statusCode, answer.body.slice(0, 300)).toBe(201);
    }

    const codes = answers.map((answer) => answer.json().data.code as number);

    expect(new Set(codes).size).toBe(8);
  });
});

describe("the picker's date filter over HTTP (includeUnscheduled)", () => {
  // The sheet's default filter ("Dia da rota ou sem data") sends
  // includeUnscheduled=true with a range; the querystring is parsed by the
  // route schema and again by the controller, and the second parse used to
  // refuse the boolean the first one produced (400 VALIDATION_ERROR).
  it("answers true and false with a range, and false without one", async () => {
    const town = `Datas ${randomUUID().slice(0, 8)}`;
    const [onDay, otherDay, undated] = await seedDeliveries(3, { city: town });

    await prisma.delivery.update({
      where: { id: onDay },
      data: { scheduled_date: new Date("2026-11-03T00:00:00.000Z") },
    });
    await prisma.delivery.update({
      where: { id: otherDay },
      data: { scheduled_date: new Date("2026-11-05T00:00:00.000Z") },
    });

    const ids = async (query: string) => {
      const page = await call(
        "GET",
        `/route/unrouted-deliveries/${CARRIER_A}?search=${encodeURIComponent(town)}&${query}`,
        dispatcherA,
      );

      expect(page.statusCode, page.body.slice(0, 300)).toBe(200);

      return (page.json().data as { id: string }[]).map((row) => row.id).sort();
    };

    const range = "scheduledFrom=2026-11-03&scheduledTo=2026-11-03";

    expect(await ids(`${range}&includeUnscheduled=true`)).toEqual(
      [onDay, undated].sort(),
    );
    expect(await ids(`${range}&includeUnscheduled=false`)).toEqual([onDay]);
    expect(await ids("includeUnscheduled=false")).toEqual(
      [onDay, otherDay].sort(),
    );
    expect(await ids("includeUnscheduled=true")).toEqual(
      [onDay, otherDay, undated].sort(),
    );

    const garbage = await call(
      "GET",
      `/route/unrouted-deliveries/${CARRIER_A}?includeUnscheduled=yes`,
      dispatcherA,
    );

    expect(garbage.statusCode).toBe(400);
    expect(garbage.json().code).toBe("VALIDATION_ERROR");
  });
});

describe("creating with an Idempotency-Key (§4.7)", () => {
  it("answers the resend with the same route, per company", async () => {
    const key = randomUUID();
    const [delivery] = await seedDeliveries(1);

    const first = await createRoute([delivery], {
      headers: { "idempotency-key": key },
    });
    const second = await createRoute([delivery], {
      headers: { "idempotency-key": key },
    });

    expect(second.id).toBe(first.id);
    expect((second as unknown as { replayed: boolean }).replayed).toBe(true);
    expect(
      await prisma.route.count({ where: { client_submission_id: key } }),
    ).toBe(1);

    // The same key from another company is that company's own route.
    const asB = await app.inject({
      method: "POST",
      url: `/route/create-route/${CARRIER_B}`,
      headers: { ...bearer(dispatcherB), "idempotency-key": key },
      payload: { driverId: DRIVER_B, scheduled_date: "2026-10-06" },
    });

    expect(asB.statusCode, asB.body).toBe(201);
    expect(asB.json().data.id).not.toBe(first.id);
    expect(asB.json().data.replayed).toBe(false);
  });
});

describe("releasing (§4.8)", () => {
  it("stamps released_at, answers the second click as unchanged and the stale plan as 409", async () => {
    const [delivery] = await seedDeliveries(1);
    const route = await createRoute([delivery]);

    const stale = await call(
      "PATCH",
      `/route/release-route/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        released: true,
        expectedPlanVersion: 3,
      },
    );

    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("ROUTE_PLAN_STALE");

    const first = await call(
      "PATCH",
      `/route/release-route/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        released: true,
        expectedPlanVersion: 0,
      },
    );

    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data).toMatchObject({
      unchanged: false,
      status: "RELEASED",
    });

    const again = await call(
      "PATCH",
      `/route/release-route/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        released: true,
      },
    );

    expect(again.statusCode).toBe(200);
    expect(again.json().data.unchanged).toBe(true);

    const row = await prisma.route.findUniqueOrThrow({
      where: { id: route.id },
    });

    expect(row.released_at).toBeInstanceOf(Date);

    await call(
      "PATCH",
      `/route/release-route/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        released: false,
      },
    );

    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: route.id } }))
        .released_at,
    ).toBeNull();
  });
});

describe("pinning a delivery on the map (D7)", () => {
  it("pins within the company, refuses outside Brazil and another company's delivery", async () => {
    const [delivery] = await seedDeliveries(1);
    const route = await createRoute([delivery]);

    const pinned = await call(
      "PATCH",
      `/route/set-delivery-location/${delivery}/business/${CARRIER_A}`,
      dispatcherA,
      { latitude: -23.55, longitude: -46.63 },
    );

    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(pinned.json().data).toMatchObject({
      latitude: -23.55,
      longitude: -46.63,
      geo_source: "MANUAL",
    });
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: route.id } }))
        .plan_version,
    ).toBe(1);

    const abroad = await call(
      "PATCH",
      `/route/set-delivery-location/${delivery}/business/${CARRIER_A}`,
      dispatcherA,
      { latitude: 48.85, longitude: 2.35 },
    );

    expect(abroad.statusCode).toBe(400);
    expect(abroad.json().code).toBe("DELIVERY_LOCATION_INVALID");

    const asB = await call(
      "PATCH",
      `/route/set-delivery-location/${delivery}/business/${CARRIER_B}`,
      dispatcherB,
      { latitude: -23.5, longitude: -46.6 },
    );

    expect(asB.statusCode).toBe(404);
    expect(asB.json().code).toBe("DELIVERY_NOT_FOUND");

    const asDriver = await call(
      "PATCH",
      `/route/set-delivery-location/${delivery}/business/${CARRIER_A}`,
      driverJoao,
      { latitude: -23.5, longitude: -46.6 },
    );

    expect(asDriver.statusCode).toBe(403);

    const row = await prisma.delivery.findUniqueOrThrow({
      where: { id: delivery },
    });

    expect([row.latitude, row.longitude]).toEqual([-23.55, -46.63]);
  });
});

describe("the route's map layers and the tower feed", () => {
  it("serves the captured GPS of this route, its trail only, and keeps planning lines off the tower", async () => {
    const [delivery] = await seedDeliveries(1);
    const route = await createRoute([delivery]);

    const startedAt = new Date(Date.now() - 60 * 60 * 1000);

    // One route on the street per truck and per driver (partial unique
    // indexes): the earlier case left one running.
    await prisma.route.updateMany({
      where: { businessId: CARRIER_A, status: "IN_PROGRESS" },
      data: { status: "CANCELLED" },
    });

    await prisma.route.update({
      where: { id: route.id },
      data: { status: "IN_PROGRESS", started_at: startedAt },
    });

    await prisma.deliveryEvent.create({
      data: {
        type: "ARRIVAL",
        deliveryId: delivery,
        businessId: CARRIER_A,
        routeId: route.id,
        actor: "DRIVER_APP",
        latitude: -23.51,
        longitude: -46.61,
      },
    });

    await prisma.driverPosition.createMany({
      data: [
        {
          driverId: JOAO,
          businessId: CARRIER_A,
          routeId: route.id,
          latitude: -23.5,
          longitude: -46.6,
          recorded_at: new Date(Date.now() - 30 * 60 * 1000),
        },
        {
          driverId: JOAO,
          businessId: CARRIER_A,
          routeId: null,
          latitude: -22.9,
          longitude: -43.2,
          recorded_at: new Date(Date.now() - 20 * 60 * 1000),
        },
      ],
    });

    await prisma.driverLastPosition.create({
      data: {
        driverId: JOAO,
        businessId: CARRIER_A,
        routeId: route.id,
        latitude: -23.5,
        longitude: -46.6,
        recorded_at: new Date(),
      },
    });

    const detail = await call(
      "GET",
      `/route/get-route/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
    );

    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data.visitedPoints).toEqual([
      expect.objectContaining({
        deliveryId: delivery,
        type: "ARRIVAL",
        latitude: -23.51,
      }),
    ]);
    expect(detail.json().data.driverPosition).toMatchObject({
      latitude: -23.5,
      fresh: true,
    });

    const trail = await call(
      "GET",
      `/route/driver-trail/${JOAO}?routeId=${route.id}`,
      dispatcherA,
    );

    expect(trail.statusCode, trail.body).toBe(200);
    expect(trail.json().data.recorded).toBe(1);

    const foreignTrail = await call(
      "GET",
      `/route/driver-trail/${DRIVER_B}?routeId=${route.id}`,
      dispatcherB,
    );

    expect(foreignTrail.statusCode).toBe(404);

    const feed = await new OperationDayRepository(prisma).listFeed(
      CARRIER_A,
      operationDay("America/Sao_Paulo", new Date()),
      200,
    );

    expect(feed.some((entry) => entry.type === "ROUTE_ADDED")).toBe(false);
    expect(feed.some((entry) => entry.type === "ARRIVAL")).toBe(true);
  });

  it('lists only the "não entrega" occurrences on the tower feed (decision 14.3)', async () => {
    const [delivery] = await seedDeliveries(1);
    const reporter = await prisma.user.findFirstOrThrow({
      where: { businessId: CARRIER_A, role: "BUSINESS_ADMIN" },
    });

    const [proofType, problemType] = await Promise.all([
      prisma.occurrenceType.create({
        data: {
          name: "Entrega normal E2E",
          category: "DELIVERED",
          businessId: CARRIER_A,
        },
      }),
      prisma.occurrenceType.create({
        data: { name: "Cliente ausente E2E", businessId: CARRIER_A },
      }),
    ]);

    for (const [type, category] of [
      [proofType, "DELIVERED"],
      [problemType, "NOT_DELIVERED"],
    ] as const) {
      await prisma.deliveryOccurrence.create({
        data: {
          id: randomUUID(),
          deliveryId: delivery,
          businessId: CARRIER_A,
          occurrenceTypeId: type.id,
          reportedById: reporter.id,
          category,
        },
      });
    }

    const feed = await new OperationDayRepository(prisma).listFeed(
      CARRIER_A,
      operationDay("America/Sao_Paulo", new Date()),
      200,
    );

    const occurrences = feed
      .filter((entry) => entry.source === "occurrence")
      .map((entry) => entry.detail);

    // The proof is a delivery-category occurrence now; it already shows as
    // its PROOF event and must not show twice, as a "problem".
    expect(occurrences).toContain("Cliente ausente E2E");
    expect(occurrences).not.toContain("Entrega normal E2E");
  });
});

/** The kinds get-delivery documents for its timeline (delivery-documentation). */
const DOCUMENTED_TIMELINE_KINDS = [
  "ARRIVAL",
  "PROOF",
  "STATUS_CHANGE",
  "NOTE",
  "ON_THE_WAY",
  "OCCURRENCE",
  "MESSAGE",
];

describe("the delivery's trail after plan changes (review r1 blocker)", () => {
  it("keeps every timeline kind one the readers know, for a delivery added, moved and removed", async () => {
    const [delivery, other] = await seedDeliveries(2);

    await createRoute([delivery, other]);

    const second = await createRoute([], {
      driverId: MARIA,
      vehicleId: TRUCK_MARIA,
    });

    const moved = await call(
      "POST",
      `/route/move-stops/${second.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        deliveryIds: [delivery],
      },
    );

    expect(moved.statusCode, moved.body).toBe(200);

    const stops = await openStops(second.id);
    const removed = await call(
      "POST",
      `/route/remove-stops/${second.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        stopIds: stops.map((stop) => stop.id),
      },
    );

    expect(removed.statusCode, removed.body).toBe(200);

    const detail = await call(
      "GET",
      `/delivery/get-delivery/${delivery}/business/${CARRIER_A}`,
      dispatcherA,
    );

    expect(detail.statusCode, detail.body.slice(0, 300)).toBe(200);

    // A kind outside this list crashed the web timeline (KIND_META[kind] was
    // undefined): the planning lines stay off the trail until the readers
    // know them.
    const kinds = (detail.json().data.timeline as Array<{ kind: string }>).map(
      (entry) => entry.kind,
    );

    expect(
      kinds.filter((kind) => !DOCUMENTED_TIMELINE_KINDS.includes(kind)),
    ).toEqual([]);
  });
});

describe("plans that change without the page (D5, review r1)", () => {
  const REASON = "018f7e70-0000-7000-8000-0000000000c1";

  beforeAll(async () => {
    await prisma.statusChangeReason.create({
      data: { id: REASON, name: "Cliente desistiu", businessId: CARRIER_A },
    });
  });

  it("moves the version when a cancelled delivery leaves a planned route, so a stale release is refused", async () => {
    const [cancelled, kept] = await seedDeliveries(2);
    const route = await createRoute([cancelled, kept]);

    expect(route.planVersion).toBe(0);

    const cancel = await call(
      "PATCH",
      `/delivery/update-delivery-status/${cancelled}/business/${CARRIER_A}`,
      dispatcherA,
      { status: "CANCELLED", reasonId: REASON },
    );

    expect(cancel.statusCode, cancel.body).toBe(200);

    const after = await prisma.route.findUniqueOrThrow({
      where: { id: route.id },
    });

    expect(after.plan_version).toBe(1);
    expect((await openStops(route.id)).map((stop) => stop.deliveryId)).toEqual([
      kept,
    ]);

    const stale = await call(
      "PATCH",
      `/route/release-route/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        released: true,
        expectedPlanVersion: 0,
      },
    );

    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("ROUTE_PLAN_STALE");
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: route.id } }))
        .status,
    ).toBe("PLANNED");
  });

  it("moves the version of the route the deprecated assignment took stops from", async () => {
    const [taken, left] = await seedDeliveries(2);
    const source = await createRoute([taken, left]);

    const assigned = await app.inject({
      method: "PATCH",
      url: `/delivery/assign-deliveries/${CARRIER_A}`,
      headers: bearer(dispatcherA),
      payload: {
        deliveryIds: [taken],
        driverId: MARIA,
        vehicleId: TRUCK_MARIA,
      },
    });

    expect(assigned.statusCode, assigned.body).toBe(200);

    const after = await prisma.route.findUniqueOrThrow({
      where: { id: source.id },
    });

    expect(after.plan_version).toBe(1);
    expect((await openStops(source.id)).map((stop) => stop.deliveryId)).toEqual(
      [left],
    );
  });
});

describe("guards as wired on move, open-stops, pin and the route trail (review r1)", () => {
  it("refuses another company, a foreign delivery, a read-only profile and a driver on move-stops, writing nothing", async () => {
    const [moving] = await seedDeliveries(1);
    const source = await createRoute([moving]);
    const target = await createRoute([], {
      driverId: MARIA,
      vehicleId: TRUCK_MARIA,
    });
    const [foreign] = await seedDeliveries(1, { businessId: CARRIER_B });

    const asB = await call(
      "POST",
      `/route/move-stops/${target.id}/business/${CARRIER_B}`,
      dispatcherB,
      {
        deliveryIds: [moving],
      },
    );

    expect(asB.statusCode).toBe(404);
    expect(asB.json().code).toBe("DELIVERY_ROUTE_NOT_FOUND");

    const intoA = await call(
      "POST",
      `/route/move-stops/${target.id}/business/${CARRIER_A}`,
      dispatcherB,
      {
        deliveryIds: [moving],
      },
    );

    expect(intoA.statusCode).toBe(403);

    const injected = await call(
      "POST",
      `/route/move-stops/${target.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        deliveryIds: [moving, foreign],
      },
    );

    // Another company's delivery answers like a missing one (no oracle).
    expect(injected.statusCode).toBe(404);
    expect(injected.json().code).toBe("DELIVERY_NOT_FOUND");

    const missing = await call(
      "POST",
      `/route/move-stops/${target.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        deliveryIds: [moving, randomUUID()],
      },
    );

    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toBe(injected.json().message);

    const readOnly = await call(
      "POST",
      `/route/move-stops/${target.id}/business/${CARRIER_A}`,
      readOnlyA,
      {
        deliveryIds: [moving],
      },
    );

    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().code).toBe("PERMISSION_DENIED");

    const asDriver = await call(
      "POST",
      `/route/move-stops/${target.id}/business/${CARRIER_A}`,
      driverJoao,
      {
        deliveryIds: [moving],
      },
    );

    expect(asDriver.statusCode).toBe(403);
    expect(asDriver.json().code).toBe("DRIVER_CANNOT_MANAGE_DELIVERIES");

    // Nothing moved, nothing bumped, the shadow still points at the source.
    expect((await openStops(source.id)).map((stop) => stop.deliveryId)).toEqual(
      [moving],
    );
    expect(await openStops(target.id)).toEqual([]);

    const versions = await prisma.route.findMany({
      where: { id: { in: [source.id, target.id] } },
      select: { plan_version: true },
    });

    expect(versions.map((row) => row.plan_version)).toEqual([0, 0]);
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: moving } }))
        .driverId,
    ).toBe(JOAO);
    expect(
      await prisma.routeStop.count({ where: { deliveryId: foreign } }),
    ).toBe(0);
  });

  it("answers open-stops to a read-only profile and refuses a driver", async () => {
    const [held] = await seedDeliveries(1);
    const route = await createRoute([held]);

    const readOnly = await call(
      "GET",
      `/route/open-stops/${CARRIER_A}?deliveryIds=${held}`,
      readOnlyA,
    );

    expect(readOnly.statusCode, readOnly.body).toBe(200);
    expect(readOnly.json().data).toEqual([
      expect.objectContaining({ deliveryId: held, routeId: route.id }),
    ]);

    const asDriver = await call(
      "GET",
      `/route/open-stops/${CARRIER_A}?deliveryIds=${held}`,
      driverJoao,
    );

    expect(asDriver.statusCode).toBe(403);
    expect(asDriver.json().code).toBe("DRIVER_CANNOT_MANAGE_DELIVERIES");
  });

  it("refuses a pin from a read-only profile and answers the dispatcher's pin with the new plan version", async () => {
    const [delivery] = await seedDeliveries(1);
    const route = await createRoute([delivery]);

    const readOnly = await call(
      "PATCH",
      `/route/set-delivery-location/${delivery}/business/${CARRIER_A}`,
      readOnlyA,
      { latitude: -23.55, longitude: -46.63 },
    );

    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().code).toBe("PERMISSION_DENIED");
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: delivery } }))
        .latitude,
    ).toBeNull();

    const pinned = await call(
      "PATCH",
      `/route/set-delivery-location/${delivery}/business/${CARRIER_A}`,
      dispatcherA,
      { latitude: -23.55, longitude: -46.63 },
    );

    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(pinned.json().data).toMatchObject({
      routeId: route.id,
      planVersion: 1,
    });
  });

  it("refuses the trail of a route that is not that driver's or not the company's", async () => {
    const [delivery] = await seedDeliveries(1);
    const route = await createRoute([delivery]);

    // Another driver of the same company, asked with João's route.
    const otherDriver = await call(
      "GET",
      `/route/driver-trail/${MARIA}?routeId=${route.id}`,
      dispatcherA,
    );

    expect(otherDriver.statusCode).toBe(404);

    // Another company's driver, asked from company A.
    const foreignDriver = await call(
      "GET",
      `/route/driver-trail/${DRIVER_B}?routeId=${route.id}`,
      dispatcherA,
    );

    expect(foreignDriver.statusCode).toBe(404);

    // Company B asking for João with A's route.
    const fromB = await call(
      "GET",
      `/route/driver-trail/${JOAO}?routeId=${route.id}`,
      dispatcherB,
    );

    expect(fromB.statusCode).toBe(404);
  });
});

describe("the picker's shipper filter (§5.5, review r1)", () => {
  it("counts shippers disjunctively, names them per company and filters by id", async () => {
    const SHIPPER_A2 = "018f7e70-0000-7000-8000-0000000000f2";

    await prisma.shipper.create({
      data: { id: SHIPPER_A2, name: "Atacado Dois", businessId: CARRIER_A },
    });

    const town = `Itu ${randomUUID().slice(0, 8)}`;

    const [first] = await seedDeliveries(2, { city: town });
    const [other] = await seedDeliveries(1, {
      city: town,
      shipperId: SHIPPER_A2,
    });

    const page = await call(
      "GET",
      `/route/unrouted-deliveries/${CARRIER_A}?search=${encodeURIComponent(town)}&shipperIds=${SHIPPER_A2}`,
      dispatcherA,
    );

    expect(page.statusCode, page.body.slice(0, 300)).toBe(200);

    const body = page.json();

    expect(body.data.map((row: { id: string }) => row.id)).toEqual([other]);

    // The shipper filter leaves its own counts alone: both options, by name.
    expect(body.meta.facets.shipper).toEqual([
      { value: SHIPPER_A2, count: 1, label: "Atacado Dois" },
      { value: SHIPPER_A, count: 2, label: "Embarcador" },
    ]);
    expect(first).toBeTruthy();

    // Another company's picker never lists A's shippers.
    const fromB = await call(
      "GET",
      `/route/unrouted-deliveries/${CARRIER_B}?search=${encodeURIComponent(town)}`,
      dispatcherB,
    );

    expect(fromB.statusCode).toBe(200);
    expect(fromB.json().meta.facets.shipper).toEqual([]);
  });
});

/**
 * Design §7.2: the driver of a RELEASED route hears that its plan changed
 * even with the app closed. One push per plan version (the event key), and
 * none while the route is still a draft.
 */
describe("the push of a released route's new plan (§7.2)", () => {
  const pushesOf = (routeId: string) =>
    prisma.domainOutboxEvent.findMany({
      where: { topic: "route.plan_changed", aggregateId: routeId },
      orderBy: { created_at: "asc" },
    });

  it("queues one route.plan_changed per version of a released route, and none for a draft", async () => {
    const [first, second, third] = await seedDeliveries(3);
    const route = await createRoute([first]);

    // A draft: the driver does not see it, nobody is pushed.
    const draftAdd = await call(
      "POST",
      `/route/add-stops/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        deliveryIds: [second],
      },
    );

    expect(draftAdd.statusCode, draftAdd.body).toBe(201);
    expect(await pushesOf(route.id)).toEqual([]);

    const release = await call(
      "PATCH",
      `/route/release-route/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        released: true,
      },
    );

    expect(release.statusCode, release.body).toBe(200);

    const added = await call(
      "POST",
      `/route/add-stops/${route.id}/business/${CARRIER_A}`,
      dispatcherA,
      {
        deliveryIds: [third],
      },
    );

    expect(added.statusCode, added.body).toBe(201);

    const version = added.json().data.planVersion as number;
    const joaoUserId = (
      await prisma.user.findFirstOrThrow({ where: { driverId: JOAO } })
    ).id;
    const pushes = await pushesOf(route.id);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      eventKey: `route:${route.id}:plan:${version}`,
      businessId: CARRIER_A,
      payload: {
        routeId: route.id,
        driverUserId: joaoUserId,
        code: route.code,
        planVersion: version,
      },
    });
  });
});
