import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";

import {
  fakeJpeg,
  seedFleetDriver,
  seedUser,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * The substitute driver (FLEET-ASSIGN-1, decision 8.2), end to end.
 *
 * Ana is the truck's responsible driver; the dispatcher gives Bruno a route
 * with it. Only `Vehicle.driverId` used to authorise the app, so Bruno drove
 * the truck out and then could not fuel it ("Este veículo não está atribuído
 * a você"), could not do its checklist, and did not see it in his vehicle
 * list. Here: through the real routes, guards and database, before the route
 * (refused), while it is released (allowed) and after it ends (refused
 * again).
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let seed: FleetDriverSeed;
let uploads: UploadService;

const BUSINESS = "018fe300-0000-7000-8000-00000000000a";

let substituteId = "";
let substituteToken = "";
let routeId = "";

const storedKeys: string[] = [];

async function storedPhoto(
  uploadType: "odometerPhotos" | "checklistPhotos",
): Promise<string> {
  const key = `${uploadType}/${BUSINESS}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

async function currentMileage(): Promise<number> {
  const vehicle = await prisma.vehicle.findUniqueOrThrow({
    where: { id: seed.vehicleId },
  });

  return vehicle.current_mileage;
}

async function fuel() {
  return app.inject({
    method: "POST",
    url: `/fuel/create-fuel/${BUSINESS}`,
    headers: { authorization: `Bearer ${substituteToken}` },
    payload: {
      client_submission_id: randomUUID(),
      current_mileage: (await currentMileage()) + 100,
      liters_amount: 50,
      price_per_liter: 6.5,
      total_amount: 325,
      refueling_date: new Date(Date.now() - 60_000).toISOString(),
      vehicleId: seed.vehicleId,
      driverId: substituteId,
      fuelTypeId: seed.fuelTypeId,
      branchId: seed.branchId,
      businessId: BUSINESS,
      latitude: -23.55,
      longitude: -46.63,
      created_from: "MOBILE_APP",
      photo: { key: await storedPhoto("odometerPhotos") },
    },
  });
}

async function checklist() {
  const photos = await Promise.all(
    ["current_mileage", "fuel_level_adequate", "tires_condition"].map(
      async (fieldName) => ({
        key: await storedPhoto("checklistPhotos"),
        fieldName,
      }),
    ),
  );

  return app.inject({
    method: "POST",
    url: `/vehicle-checklist/create-vehicle-checklist/${BUSINESS}`,
    headers: { authorization: `Bearer ${substituteToken}` },
    payload: {
      client_submission_id: randomUUID(),
      vehicleId: seed.vehicleId,
      businessId: BUSINESS,
      branchId: seed.branchId,
      driverId: substituteId,
      checklist_date: new Date(Date.now() - 60_000).toISOString(),
      current_mileage: (await currentMileage()) + 10,
      created_from: "MOBILE_APP",
      headlights_working: true,
      taillights_working: true,
      turn_signals_working: true,
      seatbelts_working: true,
      dashboard_working: true,
      brakes_working: true,
      clutch_working: true,
      fuel_level_adequate: true,
      oil_level_adequate: true,
      radiator_water_adequate: true,
      brake_fluid_adequate: true,
      driver_license_valid: true,
      vehicle_documents_valid: true,
      insurance_valid: true,
      fire_extinguisher_valid: true,
      warning_triangle_present: true,
      jack_present: true,
      tires_condition: "good",
      bumpers_condition: "good",
      windshield_condition: "good",
      mirrors_condition: "good",
      steering_wheel_condition: "good",
      battery_condition: "good",
      spare_tire_condition: "good",
      overall_condition: "approved",
      photos,
    },
  });
}

async function myVehicles(): Promise<string[]> {
  const response = await app.inject({
    method: "GET",
    url: `/vehicle/search-vehicle-business?businessId=${BUSINESS}`,
    headers: { authorization: `Bearer ${substituteToken}` },
  });

  expect(response.statusCode, response.body).toBe(200);

  return response.body
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => (JSON.parse(line) as { id: string }).id);
}

/** The vehicle's histories the app opens from its card. */
function history(kind: "fuel" | "service-order") {
  const url =
    kind === "fuel"
      ? `/fuel/search-fuel-by-vehicle/${seed.vehicleId}`
      : `/service-order/search-service-order-by-vehicle/${seed.vehicleId}`;

  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${substituteToken}` },
  });
}

function getVehicle() {
  return app.inject({
    method: "GET",
    url: `/vehicle/get-vehicle/${seed.vehicleId}/business/${BUSINESS}`,
    headers: { authorization: `Bearer ${substituteToken}` },
  });
}

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "66777888000191",
    mileage: 1_000,
  });

  const substitute = await prisma.driver.create({
    data: {
      name: "Bruno Substituto",
      birth_date: new Date("1991-01-01"),
      cnh: randomUUID().replace(/-/g, "").slice(0, 11),
      cpf: randomUUID().slice(0, 14),
      rg: randomUUID().slice(0, 12),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: BUSINESS,
      branchId: seed.branchId,
    },
  });

  substituteId = substitute.id;
  substituteToken = (
    await seedUser(prisma, BUSINESS, "BUSINESS_USER", substitute.id)
  ).token;

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

/**
 * The refusal the app shows, the same at the pump and at the checklist as on
 * the vehicle routes: 403 VEHICLE_NOT_ASSIGNED_TO_DRIVER. The checklist used
 * to answer 400 without a code.
 */
function expectNotAssigned(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => { code?: string; message?: string };
}) {
  expect(response.statusCode).toBe(403);
  expect(response.json().code).toBe("VEHICLE_NOT_ASSIGNED_TO_DRIVER");
  expect(response.headers["x-error-code"]).toBe(
    "VEHICLE_NOT_ASSIGNED_TO_DRIVER",
  );
  expect(response.json().message).toContain("não está atribuído a você");
}

describe("before any route, the truck is Ana's alone", () => {
  it("refuses Bruno at the pump, at the checklist and at the detail", async () => {
    expectNotAssigned(await fuel());
    expectNotAssigned(await checklist());
    expect((await getVehicle()).statusCode).toBe(403);
    expect(await myVehicles()).toEqual([]);
    expect((await history("fuel")).statusCode).not.toBe(200);
    expect((await history("service-order")).statusCode).not.toBe(200);
  });
});

describe("with a released route of Bruno's on the truck", () => {
  beforeAll(async () => {
    const route = await prisma.route.create({
      data: {
        code: 1,
        status: "RELEASED",
        scheduled_date: new Date("2026-09-28"),
        businessId: BUSINESS,
        driverId: substituteId,
        vehicleId: seed.vehicleId,
      },
    });

    routeId = route.id;
  });

  it("lists the truck among Bruno's vehicles", async () => {
    // Red before: the list filtered by Vehicle.driverId only.
    expect(await myVehicles()).toEqual([seed.vehicleId]);
    expect((await getVehicle()).statusCode).toBe(200);
  });

  it("lets Bruno fuel it", async () => {
    // Red before: 403 "Este veículo não está atribuído a você".
    const response = await fuel();

    expect(response.statusCode, response.body).toBe(201);
  });

  it("lets Bruno do its checklist", async () => {
    const response = await checklist();

    expect(response.statusCode, response.body).toBe(201);
  });

  it("lets Bruno read the truck's fueling and service-order histories", async () => {
    // The same predicate as the writes (canDriverOperateVehicle): comparing
    // only Vehicle.driverId hid the histories from the substitute.
    const fuels = await history("fuel");

    expect(fuels.statusCode, fuels.body).toBe(200);

    const orders = await history("service-order");

    expect(orders.statusCode, orders.body).toBe(200);
  });
});

describe("once the route is over", () => {
  it("hands the truck back: Bruno is refused again", async () => {
    await prisma.route.update({
      where: { id: routeId },
      data: { status: "COMPLETED", completed_at: new Date() },
    });

    expectNotAssigned(await fuel());
    expectNotAssigned(await checklist());
    expect(await myVehicles()).toEqual([]);
    expect((await history("fuel")).statusCode).not.toBe(200);
  });
});
