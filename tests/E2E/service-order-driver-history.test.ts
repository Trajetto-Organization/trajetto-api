import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";

import {
  readNdjson,
  seedBranch,
  seedCarrier,
  seedDriver,
  seedProfile,
  seedUser,
  seedVehicle,
} from "./support/fleet-maint-seed";

/**
 * A driver's read of a vehicle's service-order history, against Postgres
 * (decision 4.4, FLEET-ASSIGN-1).
 *
 * The use case compared only Vehicle.driverId, so the substitute a
 * dispatcher put on truck X for the day could not see X's maintenance, and
 * any refusal was a plain Error the handler could not map: the app got a
 * 500 "erro no servidor" instead of "este veículo não é seu". Another
 * company's vehicle answered 403 "não pertence a esta empresa", confirming
 * the id existed somewhere else.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe300-0000-7000-8000-0000000000c1";
const OTHER = "018fe300-0000-7000-8000-0000000000c2";
const MISSING = "018fe300-0000-7000-8000-0000000000cf";

const vehicles = {
  own: "",
  released: "",
  running: "",
  planned: "",
  colleague: "",
  foreign: "",
};
const tokens = {
  responsible: "",
  substitute: "",
  admin: "",
  noMaintenance: "",
};

let routeCode = 0;

async function route(
  driverId: string,
  vehicleId: string,
  status: "PLANNED" | "RELEASED" | "IN_PROGRESS" | "COMPLETED",
): Promise<void> {
  routeCode += 1;

  await prisma.route.create({
    data: {
      code: routeCode,
      status,
      scheduled_date: new Date("2026-09-29T00:00:00.000Z"),
      businessId: CARRIER,
      driverId,
      vehicleId,
    },
  });
}

async function order(
  businessId: string,
  branchId: string,
  vehicleId: string,
  responsibleUserId: string,
  description: string,
): Promise<void> {
  await prisma.serviceOrder.create({
    data: {
      description,
      maintenance_type: "EXTERNAL",
      total_amount: 300,
      businessId,
      branchId,
      vehicleId,
      responsibleUserId,
    },
  });
}

const history = (vehicleId: string, token: string) =>
  readNdjson<{ description: string }>(
    app,
    `/service-order/search-service-order-by-vehicle/${vehicleId}?limit=50`,
    token,
  );

beforeAll(async () => {
  await seedCarrier(prisma, CARRIER);
  await seedCarrier(prisma, OTHER);

  const branchId = await seedBranch(prisma, CARRIER, "Filial Pátio");
  const otherBranch = await seedBranch(prisma, OTHER, "Filial da Outra");

  const responsibleDriver = await seedDriver(prisma, CARRIER);
  const substituteDriver = await seedDriver(prisma, CARRIER);

  vehicles.own = await seedVehicle(prisma, CARRIER, {
    plate: "HIS1A11",
    branchId,
    driverId: responsibleDriver,
  });
  vehicles.released = await seedVehicle(prisma, CARRIER, {
    plate: "HIS2B22",
    branchId,
  });
  vehicles.planned = await seedVehicle(prisma, CARRIER, {
    plate: "HIS3C33",
    branchId,
  });
  vehicles.running = await seedVehicle(prisma, CARRIER, {
    plate: "HIS6F66",
    branchId,
  });
  vehicles.colleague = await seedVehicle(prisma, CARRIER, {
    plate: "HIS4D44",
    branchId,
    driverId: responsibleDriver,
  });
  vehicles.foreign = await seedVehicle(prisma, OTHER, {
    plate: "HIS5E55",
    branchId: otherBranch,
  });

  const admin = await seedUser(prisma, "Gestora", "BUSINESS_ADMIN", CARRIER);
  const otherAdmin = await seedUser(prisma, "Outra", "BUSINESS_ADMIN", OTHER);

  tokens.admin = admin.token;
  tokens.responsible = (
    await seedUser(prisma, "Responsável", "BUSINESS_USER", CARRIER, {
      driverId: responsibleDriver,
    })
  ).token;
  tokens.substitute = (
    await seedUser(prisma, "Substituto", "BUSINESS_USER", CARRIER, {
      driverId: substituteDriver,
    })
  ).token;

  // An office profile that works deliveries and never maintenance.
  tokens.noMaintenance = (
    await seedUser(prisma, "Despacho", "BUSINESS_USER", CARRIER, {
      profileAccessId: await seedProfile(prisma, CARRIER, [
        { key: "delivery_manage", write: true },
      ]),
    })
  ).token;

  await route(substituteDriver, vehicles.released, "RELEASED");
  await route(substituteDriver, vehicles.running, "IN_PROGRESS");
  await route(substituteDriver, vehicles.planned, "PLANNED");
  // A finished route hands the truck back: no reading its history after.
  await route(substituteDriver, vehicles.own, "COMPLETED");

  await order(CARRIER, branchId, vehicles.own, admin.id, "Revisão do próprio");
  await order(CARRIER, branchId, vehicles.own, admin.id, "Pneus do próprio");
  await order(CARRIER, branchId, vehicles.released, admin.id, "Freios da rota");
  await order(
    CARRIER,
    branchId,
    vehicles.running,
    admin.id,
    "Suspensão da rota em curso",
  );
  await order(
    CARRIER,
    branchId,
    vehicles.planned,
    admin.id,
    "Óleo do rascunho",
  );
  await order(
    CARRIER,
    branchId,
    vehicles.colleague,
    admin.id,
    "Embreagem do colega",
  );
  await order(
    OTHER,
    otherBranch,
    vehicles.foreign,
    otherAdmin.id,
    "Revisão da outra",
  );

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /service-order/search-service-order-by-vehicle — the driver's vehicles", () => {
  it("answers the responsible driver with the vehicle's orders", async () => {
    const result = await history(vehicles.own, tokens.responsible);

    expect(result.status, result.body).toBe(200);
    expect(result.rows.map((row) => row.description).sort()).toEqual([
      "Pneus do próprio",
      "Revisão do próprio",
    ]);
  });

  it("answers the substitute on a released route with that truck's orders", async () => {
    const result = await history(vehicles.released, tokens.substitute);

    expect(result.status, result.body).toBe(200);
    expect(result.rows.map((row) => row.description)).toEqual([
      "Freios da rota",
    ]);
  });

  it("answers the substitute on a route in progress with that truck's orders", async () => {
    const result = await history(vehicles.running, tokens.substitute);

    expect(result.status, result.body).toBe(200);
    expect(result.rows.map((row) => row.description)).toEqual([
      "Suspensão da rota em curso",
    ]);
  });

  it("refuses with a code, not a 500, a truck only on a planned or finished route", async () => {
    for (const vehicleId of [vehicles.planned, vehicles.own]) {
      const result = await history(vehicleId, tokens.substitute);

      expect(result.status, result.body).toBe(403);
      expect(JSON.parse(result.body)).toMatchObject({
        code: "VEHICLE_NOT_ASSIGNED_TO_DRIVER",
      });
      expect(result.body).not.toContain("Óleo do rascunho");
      expect(result.body).not.toContain("do próprio");
    }
  });

  it("refuses a colleague's vehicle with 403 and none of its orders", async () => {
    const result = await history(vehicles.colleague, tokens.substitute);

    expect(result.status, result.body).toBe(403);
    expect(JSON.parse(result.body).code).toBe("VEHICLE_NOT_ASSIGNED_TO_DRIVER");
    expect(result.body).not.toContain("Embreagem do colega");
  });

  it("answers another company's vehicle exactly like a missing one", async () => {
    const foreign = await history(vehicles.foreign, tokens.responsible);
    const missing = await history(MISSING, tokens.responsible);

    expect(foreign.status, foreign.body).toBe(404);
    expect(missing.status, missing.body).toBe(404);
    expect(JSON.parse(foreign.body)).toEqual(JSON.parse(missing.body));
    expect(JSON.parse(foreign.body).code).toBe("VEHICLE_NOT_FOUND");
    expect(foreign.body).not.toContain("Revisão da outra");
  });

  it("keeps the office reading any vehicle of its company", async () => {
    const result = await history(vehicles.colleague, tokens.admin);

    expect(result.status, result.body).toBe(200);
    expect(result.rows.map((row) => row.description)).toEqual([
      "Embreagem do colega",
    ]);

    const foreign = await history(vehicles.foreign, tokens.admin);

    expect(foreign.status).toBe(404);
  });

  it("refuses an office profile without the maintenance key, with PERMISSION_DENIED", async () => {
    const result = await history(vehicles.colleague, tokens.noMaintenance);

    expect(result.status, result.body).toBe(403);
    expect(JSON.parse(result.body).code).toBe("PERMISSION_DENIED");
    expect(result.body).not.toContain("Embreagem do colega");
  });
});
