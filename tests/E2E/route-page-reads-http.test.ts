import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import {
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";
import { ROUTE_MAX_STOPS } from "@/modules/route/usecases/shared/route-plan-rules";

/**
 * The route page's reads over real HTTP and Postgres (plan of 02/11/2026,
 * G9 and F3):
 *
 * - "Adicionar entregas" pages by cursor: a colleague routing a delivery
 *   between two pages neither repeats nor skips a row (the offset did both),
 *   later pages skip the counts, and a forged cursor is a 400;
 * - the map's visited points keep the NEWEST arrivals and proofs past the
 *   cap (the ascending `take` dropped the end of the day).
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const COMPANY = randomUUID();
const OTHER = randomUUID();

let seed: FleetDriverSeed;
let other: FleetDriverSeed;
let shipperId = "";

const deliveryIds: string[] = [];

function get(url: string, token: string) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function createDelivery(
  index: number,
  scheduled: string | null,
): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: `Cliente da seleção ${index}`,
      city: "Campinas",
      uf: "SP",
      street: "Rua da Seleção",
      businessId: COMPANY,
      shipperId,
      status: "PENDING",
      scheduled_date: scheduled ? new Date(`${scheduled}T00:00:00.000Z`) : null,
      created_at: new Date(Date.UTC(2026, 10, 1, 8, index)),
    },
  });

  return delivery.id;
}

async function routeOf(
  deliveryIdsOnRoute: string[],
  status: "PLANNED" | "IN_PROGRESS" | "COMPLETED" = "PLANNED",
): Promise<string> {
  const ran = status !== "PLANNED";

  const code =
    ((
      await prisma.route.aggregate({
        where: { businessId: COMPANY },
        _max: { code: true },
      })
    )._max.code ?? 0) + 1;

  const route = await prisma.route.create({
    data: {
      code,
      status,
      scheduled_date: new Date("2026-11-03T00:00:00.000Z"),
      started_at: ran ? new Date("2026-11-03T11:00:00.000Z") : null,
      completed_at:
        status === "COMPLETED" ? new Date("2026-11-03T19:30:00.000Z") : null,
      businessId: COMPANY,
      driverId: seed.driverId,
      vehicleId: ran ? seed.vehicleId : null,
    },
  });

  for (const [index, deliveryId] of deliveryIdsOnRoute.entries()) {
    await prisma.routeStop.create({
      data: {
        routeId: route.id,
        deliveryId,
        sequence: (index + 1) * 10,
        status: "PENDING",
      },
    });
  }

  return route.id;
}

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: COMPANY,
    cnpj: `${Date.now()}`.slice(-8).padStart(8, "2") + "000191",
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: `${Date.now() + 7}`.slice(-8).padStart(8, "3") + "000191",
  });

  shipperId = (
    await prisma.shipper.create({
      data: { businessId: COMPANY, name: "Embarcador da seleção" },
    })
  ).id;

  // Five with a day (two share the first one), two without: the list order
  // is day (no day last), creation, id.
  const days = [
    "2026-11-03",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
    "2026-11-06",
    null,
    null,
  ];

  for (const [index, day] of days.entries()) {
    deliveryIds.push(await createDelivery(index, day));
  }

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("the 'Adicionar entregas' picker pages by cursor (G9)", () => {
  const url = (query: string) =>
    `/route/unrouted-deliveries/${COMPANY}?pageSize=3&search=${encodeURIComponent(
      "Cliente da seleção",
    )}${query}`;

  it("neither repeats nor skips a row when a colleague routes one between pages", async () => {
    const first = await get(url(""), seed.managerToken);

    expect(first.statusCode, first.body).toBe(200);

    const page1 = first.json();

    expect(page1.meta.total).toBe(7);
    expect(page1.meta.facets.city).toEqual([{ value: "Campinas", count: 7 }]);
    expect(page1.meta.nextCursor).toEqual(expect.any(String));
    expect(page1.data.map((row: { id: string }) => row.id)).toEqual(
      deliveryIds.slice(0, 3),
    );

    // A colleague routes the first row of the page already seen. An offset
    // would now start page two at the old fifth row and skip the fourth.
    const routeId = await routeOf([deliveryIds[0]]);

    const second = await get(
      url(`&cursor=${encodeURIComponent(page1.meta.nextCursor)}`),
      seed.managerToken,
    );

    expect(second.statusCode, second.body).toBe(200);

    const page2 = second.json();

    expect(page2.data.map((row: { id: string }) => row.id)).toEqual(
      deliveryIds.slice(3, 6),
    );
    // Later pages keep the first page's counts.
    expect(page2.meta).not.toHaveProperty("total");
    expect(page2.meta).not.toHaveProperty("facets");

    const third = await get(
      url(`&cursor=${encodeURIComponent(page2.meta.nextCursor)}`),
      seed.managerToken,
    );

    expect(third.json().data.map((row: { id: string }) => row.id)).toEqual([
      deliveryIds[6],
    ]);
    expect(third.json().meta.nextCursor).toBeNull();

    await prisma.routeStop.deleteMany({ where: { routeId } });
    await prisma.route.delete({ where: { id: routeId } });
  });

  it("still serves the offset the web in the field sends", async () => {
    const second = await get(url("&page=2"), seed.managerToken);

    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().meta.total).toBe(7);
    expect(second.json().data.map((row: { id: string }) => row.id)).toEqual(
      deliveryIds.slice(3, 6),
    );
  });

  it("refuses a forged cursor with 400 and never reaches another company", async () => {
    const forged = await get(url("&cursor=nao-e-cursor"), seed.managerToken);

    expect(forged.statusCode).toBe(400);
    expect(forged.json().code).toBe("INVALID_CURSOR");

    // A cursor taken from this company moves only the start of the other
    // company's own list: the tenant stays in the where.
    const first = (await get(url(""), seed.managerToken)).json();
    const foreign = await get(
      `/route/unrouted-deliveries/${OTHER}?pageSize=3&cursor=${encodeURIComponent(first.meta.nextCursor)}`,
      other.managerToken,
    );

    expect(foreign.statusCode, foreign.body).toBe(200);
    expect(foreign.body).not.toContain("Cliente da seleção");

    // And another company's manager cannot read this company's list.
    expect((await get(url(""), other.managerToken)).statusCode).toBe(403);
  });
});

describe("the map's visited points keep the end of the day (G9)", () => {
  it("answers the newest arrivals and proofs, oldest first, past the cap", async () => {
    const deliveryId = await createDelivery(99, null);
    const routeId = await routeOf([deliveryId], "IN_PROGRESS");

    const cap = 2 * ROUTE_MAX_STOPS;

    await prisma.deliveryEvent.createMany({
      data: Array.from({ length: cap + 5 }, (_, index) => ({
        businessId: COMPANY,
        deliveryId,
        routeId,
        type: index % 2 === 0 ? ("ARRIVAL" as const) : ("PROOF" as const),
        latitude: -23.5 + index / 100_000,
        longitude: -46.6,
        created_at: new Date(Date.UTC(2026, 10, 3, 12, 0, index)),
      })),
    });

    const response = await get(
      `/route/get-route/${routeId}/business/${COMPANY}`,
      seed.managerToken,
    );

    expect(response.statusCode, response.body).toBe(200);

    const points = response.json().data.visitedPoints as Array<{
      recordedAt: string;
    }>;

    expect(points).toHaveLength(cap);
    expect(points[0].recordedAt).toBe(
      new Date(Date.UTC(2026, 10, 3, 12, 0, 5)).toISOString(),
    );
    expect(points[points.length - 1].recordedAt).toBe(
      new Date(Date.UTC(2026, 10, 3, 12, 0, cap + 4)).toISOString(),
    );
  });

  it("carries each point's geofence record through the response, for the stop's flag (E5)", async () => {
    // The web flags a stop whose arrival was recorded outside the radius
    // (lib/geofence-flag). The response schema must declare the fields, or
    // the serializer drops them on the way out.
    const deliveryId = await createDelivery(98, null);
    // COMPLETED: the case above keeps the seed's vehicle on a running route
    // (one active route per vehicle), and the map reads the points anyway.
    const routeId = await routeOf([deliveryId], "COMPLETED");

    await prisma.deliveryEvent.createMany({
      data: [
        {
          businessId: COMPANY,
          deliveryId,
          routeId,
          type: "ARRIVAL",
          latitude: -23.5,
          longitude: -46.6,
          created_at: new Date(Date.UTC(2026, 10, 3, 13, 0, 0)),
          geofence_outcome: "OUTSIDE",
          distance_m: 820,
          accuracy_m: 12,
        },
        {
          businessId: COMPANY,
          deliveryId,
          routeId,
          type: "PROOF",
          latitude: -23.5,
          longitude: -46.6,
          created_at: new Date(Date.UTC(2026, 10, 3, 13, 5, 0)),
        },
      ],
    });

    const response = await get(
      `/route/get-route/${routeId}/business/${COMPANY}`,
      seed.managerToken,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.visitedPoints).toEqual([
      expect.objectContaining({
        type: "ARRIVAL",
        geofence_outcome: "OUTSIDE",
        distance_m: 820,
        accuracy_m: 12,
      }),
      expect.objectContaining({
        type: "PROOF",
        geofence_outcome: null,
        distance_m: null,
        accuracy_m: null,
      }),
    ]);
  });
});

describe("the stop cards' 'Fora do raio' flag (E5)", () => {
  it("flags the stop of an occurrence 800 m away that has no arrival", async () => {
    // Red before: get-route only sent the arrivals and proofs (visitedPoints)
    // and the card read only those, so an occurrence outside the radius —
    // which always passes, flagged — never reached the route detail.
    const deliveryId = await createDelivery(97, null);
    const routeId = await routeOf([deliveryId], "COMPLETED");

    await prisma.deliveryEvent.createMany({
      data: [
        {
          businessId: COMPANY,
          deliveryId,
          routeId,
          type: "OCCURRENCE",
          latitude: -23.507,
          longitude: -46.6,
          created_at: new Date(Date.UTC(2026, 10, 3, 14, 0, 0)),
          geofence_outcome: "OUTSIDE",
          distance_m: 800,
          accuracy_m: 15,
        },
      ],
    });

    const response = await get(
      `/route/get-route/${routeId}/business/${COMPANY}`,
      seed.managerToken,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.visitedPoints).toEqual([]);
    expect(response.json().data.stopGeofence).toEqual([
      {
        deliveryId,
        type: "OCCURRENCE",
        geofence_outcome: "OUTSIDE",
        distance_m: 800,
        accuracy_m: 15,
        recordedAt: new Date(Date.UTC(2026, 10, 3, 14, 0, 0)).toISOString(),
      },
    ]);

    // The driver's app has no stop card to flag.
    const driverRead = await get(
      `/route/get-route/${routeId}/business/${COMPANY}`,
      seed.driverToken,
    );

    expect(driverRead.statusCode, driverRead.body).toBe(200);
    expect(driverRead.json().data.stopGeofence).toEqual([]);
  });
});

/**
 * Plan of 02/11/2026, F3 (read side): the route detail shows what happened
 * to the vehicle on the route — the departure and arrival checklists (the
 * newest of each moment, the same shape the driver's payload carries) and
 * the refuellings made on it. Behind the FLEET module and the profile's own
 * keys: a dispatcher who cannot open Abastecimentos or Checklists does not
 * read them here either (null = not available to this reader).
 */
describe("the route detail shows the route's checklists and refuellings (F3)", () => {
  let routeId = "";
  let otherRouteId = "";
  let readOnlyToken = "";

  async function checklist(
    businessId: string,
    fleet: FleetDriverSeed,
    route: string | null,
    phase: "ROUTE_START" | "ROUTE_END" | "STANDALONE",
    at: string,
    overall: string,
  ): Promise<string> {
    const row = await prisma.vehicleChecklist.create({
      data: {
        current_mileage: 1_500,
        checklist_date: new Date(at),
        tires_condition: "good",
        bumpers_condition: "good",
        windshield_condition: "good",
        mirrors_condition: "good",
        steering_wheel_condition: "good",
        battery_condition: "good",
        spare_tire_condition: "good",
        overall_condition: overall,
        photos: [],
        businessId,
        branchId: fleet.branchId,
        vehicleId: fleet.vehicleId,
        driverId: fleet.driverId,
        routeId: route,
        phase,
      },
    });

    return row.id;
  }

  async function refuel(
    businessId: string,
    fleet: FleetDriverSeed,
    route: string | null,
    at: string,
  ): Promise<string> {
    const row = await prisma.fuel.create({
      data: {
        current_mileage: 1_600,
        liters_amount: 50,
        price_per_liter: 6,
        total_amount: 300,
        odometer_photo: `odometerPhotos/${businessId}/${randomUUID()}.jpg`,
        refueling_date: new Date(at),
        businessId,
        branchId: fleet.branchId,
        vehicleId: fleet.vehicleId,
        driverId: fleet.driverId,
        fuelTypeId: fleet.fuelTypeId,
        routeId: route,
      },
    });

    return row.id;
  }

  beforeAll(async () => {
    // Ended: the arrival checklist comes after the last stop (D08).
    routeId = await routeOf([], "COMPLETED");
    otherRouteId = await routeOf([]);

    const profile = await prisma.profileAccess.create({
      data: {
        name: `Só entregas ${randomUUID().slice(0, 6)}`,
        businessId: COMPANY,
        permissions: {
          create: [
            {
              permissionKey: "delivery_manage",
              action: "delivery_manage",
              canRead: true,
              canWrite: false,
              businessId: COMPANY,
            },
          ],
        },
      },
    });

    const userId = randomUUID();
    const familyId = randomUUID();

    await prisma.user.create({
      data: {
        id: userId,
        name: "Despachante só leitura",
        email: `${userId}@exemplo.com.br`,
        password: "not-used-here",
        role: "BUSINESS_USER",
        businessId: COMPANY,
        profileAccessId: profile.id,
      },
    });
    await prisma.refreshToken.create({
      data: {
        userId,
        token_hash: randomUUID(),
        jti: randomUUID(),
        family_id: familyId,
        expires_in: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    readOnlyToken = sign(
      { tokenType: "access", sessionVersion: 0, familyId },
      auth.secret_token,
      { subject: userId, expiresIn: "15m" },
    );
  });

  it("lists the newest checklist of each moment and the route's refuellings only", async () => {
    await checklist(
      COMPANY,
      seed,
      routeId,
      "ROUTE_START",
      "2026-11-03T10:00:00.000Z",
      "rejected",
    );
    const start = await checklist(
      COMPANY,
      seed,
      routeId,
      "ROUTE_START",
      "2026-11-03T10:30:00.000Z",
      "approved",
    );
    const end = await checklist(
      COMPANY,
      seed,
      routeId,
      "ROUTE_END",
      "2026-11-03T19:00:00.000Z",
      "approved_with_restrictions",
    );
    await checklist(
      COMPANY,
      seed,
      null,
      "STANDALONE",
      "2026-11-03T12:00:00.000Z",
      "approved",
    );
    await checklist(
      COMPANY,
      seed,
      otherRouteId,
      "ROUTE_START",
      "2026-11-03T09:00:00.000Z",
      "approved",
    );
    // Another company's row naming this route never shows.
    await checklist(
      OTHER,
      other,
      routeId,
      "ROUTE_END",
      "2026-11-03T20:00:00.000Z",
      "rejected",
    );

    const morning = await refuel(
      COMPANY,
      seed,
      routeId,
      "2026-11-03T12:00:00.000Z",
    );
    const afternoon = await refuel(
      COMPANY,
      seed,
      routeId,
      "2026-11-03T15:00:00.000Z",
    );
    await refuel(COMPANY, seed, null, "2026-11-03T13:00:00.000Z");
    await refuel(OTHER, other, routeId, "2026-11-03T14:00:00.000Z");

    const response = await get(
      `/route/get-route/${routeId}/business/${COMPANY}`,
      seed.managerToken,
    );

    expect(response.statusCode, response.body).toBe(200);

    const { checklists, fuels } = response.json().data;

    expect(checklists).toEqual({
      route_start: {
        id: start,
        checklist_date: "2026-11-03T10:30:00.000Z",
        overall_condition: "approved",
      },
      route_end: {
        id: end,
        checklist_date: "2026-11-03T19:00:00.000Z",
        overall_condition: "approved_with_restrictions",
      },
    });
    expect(fuels.map((row: { id: string }) => row.id)).toEqual([
      morning,
      afternoon,
    ]);
    expect(fuels[0]).toMatchObject({
      liters_amount: 50,
      total_amount: 300,
      vehicleId: seed.vehicleId,
    });

    // The driver of the route reads them too (their own records).
    const asDriver = await get(
      `/route/get-route/${routeId}/business/${COMPANY}`,
      seed.driverToken,
    );

    expect(asDriver.statusCode, asDriver.body).toBe(200);
    expect(asDriver.json().data.checklists.route_start.id).toBe(start);
    expect(asDriver.json().data.fuels).toHaveLength(2);
  });

  it("answers what exists, empty and not null, for a route with little", async () => {
    const response = await get(
      `/route/get-route/${otherRouteId}/business/${COMPANY}`,
      seed.managerToken,
    );

    expect(response.json().data.checklists).toEqual({
      route_start: expect.objectContaining({ overall_condition: "approved" }),
      route_end: null,
    });
    expect(response.json().data.fuels).toEqual([]);
  });

  it("leaves them out (null) for a profile that cannot open the fleet records", async () => {
    const response = await get(
      `/route/get-route/${routeId}/business/${COMPANY}`,
      readOnlyToken,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.checklists).toBeNull();
    expect(response.json().data.fuels).toBeNull();
  });

  it("leaves them out (null) while the company has FLEET switched off", async () => {
    await prisma.businessEntitlement.updateMany({
      where: { businessId: COMPANY, module: "FLEET" },
      data: { enabled: false },
    });

    try {
      const response = await get(
        `/route/get-route/${routeId}/business/${COMPANY}`,
        seed.managerToken,
      );

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.checklists).toBeNull();
      expect(response.json().data.fuels).toBeNull();
    } finally {
      await prisma.businessEntitlement.updateMany({
        where: { businessId: COMPANY, module: "FLEET" },
        data: { enabled: true },
      });
    }
  });
});
