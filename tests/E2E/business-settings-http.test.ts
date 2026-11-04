import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";

import {
  seedFleetDriver,
  seedUser,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * "Configurações da empresa" (plan of 02/11/2026, M1, M6, C2, C4) through the
 * real routes and a real database:
 *
 * - GET/PUT /business/:businessId/settings for the company's own admin and a
 *   MASTER only; another company's id refused the same whether it exists or
 *   not; the bounds of a save; the audit event committed with a real change
 *   and only then;
 * - the session (/user/me) and the driver's payload (my-deliveries) carry
 *   the values, each route of the payload its plate and the status of its
 *   departure and arrival checklists, read from the checklists made for it.
 */
const prisma = createPrismaClient();

const CARRIER = "018fe5c0-0000-7000-8000-00000000000a";
const OTHER = "018fe5c0-0000-7000-8000-00000000000b";
const MISSING = "018fe5c0-0000-7000-8000-0000000000ee";

let app: Awaited<typeof import("@/http")>["app"];
let carrier: FleetDriverSeed;
let other: FleetDriverSeed;
let masterToken = "";
let collaboratorToken = "";
let routeId = "";

async function seedMaster(): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Mestre",
      email: `${id}@trajetto.test`,
      password: "not-used-here",
      role: "MASTER",
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
    { subject: id, expiresIn: "30m" },
  );
}

const settingsUrl = (businessId: string) => `/business/${businessId}/settings`;

const getSettings = (token: string, businessId = CARRIER) =>
  app.inject({
    method: "GET",
    url: settingsUrl(businessId),
    headers: { authorization: `Bearer ${token}` },
  });

const putSettings = (
  token: string,
  payload: Record<string, unknown>,
  businessId = CARRIER,
) =>
  app.inject({
    method: "PUT",
    url: settingsUrl(businessId),
    headers: { authorization: `Bearer ${token}` },
    payload,
  });

const settingsEvents = () =>
  prisma.domainOutboxEvent.findMany({
    where: { topic: "business-settings.changed", businessId: CARRIER },
    orderBy: { created_at: "asc" },
  });

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: String(58000000000000 + Math.floor(Math.random() * 9000000)),
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: String(59000000000000 + Math.floor(Math.random() * 9000000)),
  });

  masterToken = await seedMaster();
  // An office collaborator with an access profile, as the panel creates one.
  const collaborator = await seedUser(prisma, CARRIER, "BUSINESS_USER");
  const profile = await prisma.profileAccess.create({
    data: {
      name: "Operação",
      businessId: CARRIER,
      permissions: {
        create: {
          action: "Gerenciar entregas",
          permissionKey: "delivery_manage",
          canRead: true,
          canWrite: true,
          businessId: CARRIER,
        },
      },
    },
  });

  await prisma.user.update({
    where: { id: collaborator.id },
    data: { profileAccessId: profile.id },
  });
  collaboratorToken = collaborator.token;

  // The driver's released route, with one stop and a departure checklist.
  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId: CARRIER },
  });
  const delivery = await prisma.delivery.create({
    data: {
      businessId: CARRIER,
      shipperId: shipper.id,
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status: "PENDING",
      driverId: carrier.driverId,
      vehicleId: carrier.vehicleId,
    },
  });
  const route = await prisma.route.create({
    data: {
      code: 7,
      businessId: CARRIER,
      driverId: carrier.driverId,
      vehicleId: carrier.vehicleId,
      status: "RELEASED",
      released_at: new Date(),
      scheduled_date: new Date("2026-11-02T00:00:00.000Z"),
    },
  });

  routeId = route.id;

  await prisma.routeStop.create({
    data: { routeId, deliveryId: delivery.id, sequence: 10 },
  });

  const checklist = {
    current_mileage: 1_000,
    tires_condition: "good",
    bumpers_condition: "good",
    windshield_condition: "good",
    mirrors_condition: "good",
    steering_wheel_condition: "good",
    battery_condition: "good",
    spare_tire_condition: "good",
    photos: [],
    businessId: CARRIER,
    branchId: carrier.branchId,
    vehicleId: carrier.vehicleId,
    driverId: carrier.driverId,
  };

  await prisma.vehicleChecklist.createMany({
    data: [
      {
        ...checklist,
        id: "018fe5c0-0000-7000-8000-0000000c0001",
        overall_condition: "approved",
        routeId,
        phase: "ROUTE_START",
        checklist_date: new Date("2026-11-02T07:30:00.000Z"),
      },
      // Made outside the route: never the route's.
      {
        ...checklist,
        id: "018fe5c0-0000-7000-8000-0000000c0002",
        overall_condition: "rejected",
        routeId,
        phase: "STANDALONE",
        checklist_date: new Date("2026-11-02T09:00:00.000Z"),
      },
    ],
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /business/:businessId/settings", () => {
  it("gives a company that never saved the defaults", async () => {
    const response = await getSettings(carrier.managerToken);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual({
      businessId: CARRIER,
      checklist_requirement: "NONE",
      arrival_geofence_mode: "DISABLED",
      arrival_geofence_radius_m: 500,
      available: { checklist: true, geofence: true },
      limits: { geofence_radius_min_m: 50, geofence_radius_max_m: 5000 },
      updated_at: null,
      updated_by: null,
    });
  });

  it("refuses a collaborator and a driver (403 AUTH_ROLE_FORBIDDEN)", async () => {
    for (const token of [collaboratorToken, carrier.driverToken]) {
      const response = await getSettings(token);

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().code).toBe("AUTH_ROLE_FORBIDDEN");
    }
  });

  it("refuses another company's admin the same for an existing and a missing id", async () => {
    for (const businessId of [CARRIER, MISSING]) {
      const response = await getSettings(other.managerToken, businessId);

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().code).toBe("TENANT_ACCESS_DENIED");
    }
  });

  it("answers a MASTER for any company, and 404 for a missing one", async () => {
    expect((await getSettings(masterToken, OTHER)).statusCode).toBe(200);

    const missing = await getSettings(masterToken, MISSING);

    expect(missing.statusCode, missing.body).toBe(404);
    expect(missing.json().code).toBe("BUSINESS_NOT_FOUND");
  });
});

describe("PUT /business/:businessId/settings", () => {
  it.each([
    ["a radius below 50 m", { arrival_geofence_radius_m: 49 }],
    ["a radius above 5,000 m", { arrival_geofence_radius_m: 5001 }],
    ["an unknown mode", { arrival_geofence_mode: "WARN" }],
    ["nothing to save", {}],
    [
      "a company in the body",
      { arrival_geofence_mode: "ALERT", businessId: OTHER },
    ],
  ])("refuses %s with 400 VALIDATION_ERROR", async (_label, payload) => {
    const response = await putSettings(carrier.managerToken, payload);

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
  });

  it("saves the fields given and audits the movement in the same commit", async () => {
    const response = await putSettings(carrier.managerToken, {
      checklist_requirement: "ROUTE_START",
      arrival_geofence_mode: "BLOCK",
      arrival_geofence_radius_m: 300,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      checklist_requirement: "ROUTE_START",
      arrival_geofence_mode: "BLOCK",
      arrival_geofence_radius_m: 300,
      updated_by: { name: "Gestora" },
    });

    expect(
      await prisma.businessSettings.findUnique({
        where: { businessId: CARRIER },
      }),
    ).toMatchObject({
      checklist_requirement: "ROUTE_START",
      arrival_geofence_mode: "BLOCK",
      arrival_geofence_radius_m: 300,
    });

    const events = await settingsEvents();

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      businessId: CARRIER,
      changes: [
        { field: "checklist_requirement", from: "NONE", to: "ROUTE_START" },
        { field: "arrival_geofence_mode", from: "DISABLED", to: "BLOCK" },
        { field: "arrival_geofence_radius_m", from: 500, to: 300 },
      ],
      actor: { role: "BUSINESS_ADMIN" },
    });
  });

  it("saving what is already there audits nothing", async () => {
    const response = await putSettings(carrier.managerToken, {
      arrival_geofence_mode: "BLOCK",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await settingsEvents()).toHaveLength(1);
  });

  it("refuses another company's admin without touching the settings", async () => {
    const response = await putSettings(other.managerToken, {
      arrival_geofence_mode: "DISABLED",
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("TENANT_ACCESS_DENIED");
    expect(
      (
        await prisma.businessSettings.findUnique({
          where: { businessId: CARRIER },
        })
      )?.arrival_geofence_mode,
    ).toBe("BLOCK");
  });
});

describe("the settings in the session and in the driver's payload", () => {
  it("/user/me carries the company's settings, and another company's stay apart", async () => {
    const mine = await app.inject({
      method: "GET",
      url: "/user/me",
      headers: { authorization: `Bearer ${carrier.driverToken}` },
    });
    const theirs = await app.inject({
      method: "GET",
      url: "/user/me",
      headers: { authorization: `Bearer ${other.driverToken}` },
    });

    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().user.businessSettings).toEqual({
      checklist_requirement: "ROUTE_START",
      arrival_geofence_mode: "BLOCK",
      arrival_geofence_radius_m: 300,
    });
    expect(theirs.json().user.businessSettings).toEqual({
      checklist_requirement: "NONE",
      arrival_geofence_mode: "DISABLED",
      arrival_geofence_radius_m: 500,
    });
  });

  it("my-deliveries carries the settings, the route's plate and its checklists", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/delivery/my-deliveries/${CARRIER}`,
      headers: { authorization: `Bearer ${carrier.driverToken}` },
    });

    expect(response.statusCode, response.body).toBe(200);

    const body = response.json();
    const plate = (
      await prisma.vehicle.findUniqueOrThrow({
        where: { id: carrier.vehicleId },
      })
    ).license_plate;

    expect(body.settings).toEqual({
      checklist_requirement: "ROUTE_START",
      arrival_geofence_mode: "BLOCK",
      arrival_geofence_radius_m: 300,
    });
    expect(body.routes).toEqual([
      {
        id: routeId,
        code: 7,
        plan_version: 0,
        vehicle: { id: carrier.vehicleId, license_plate: plate },
        checklists: {
          route_start: {
            id: "018fe5c0-0000-7000-8000-0000000c0001",
            checklist_date: "2026-11-02T07:30:00.000Z",
            overall_condition: "approved",
          },
          route_end: null,
        },
        // C4: a route with an open stop has not ended.
        completed_at: null,
      },
    ]);
    // The stop's route carries the plate too, for the card drawn from cache.
    expect(body.data[0].stops[0].route.vehicle).toEqual({
      id: carrier.vehicleId,
      license_plate: plate,
    });
  });

  it("a company with the fleet off sends no route checklist (M6)", async () => {
    await prisma.businessEntitlement.updateMany({
      where: { businessId: CARRIER, module: "FLEET" },
      data: { enabled: false },
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: `/delivery/my-deliveries/${CARRIER}`,
        headers: { authorization: `Bearer ${carrier.driverToken}` },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().settings).toMatchObject({
        checklist_requirement: "NONE",
        arrival_geofence_mode: "BLOCK",
      });
    } finally {
      await prisma.businessEntitlement.updateMany({
        where: { businessId: CARRIER, module: "FLEET" },
        data: { enabled: true },
      });
    }
  });
});
