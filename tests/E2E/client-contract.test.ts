import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * What an app build can tell apart when the API says no (GAP5-2).
 *
 * The driver's outbox has to decide, from the answer alone, between "the API
 * refused this on its merits" (a mileage below the odometer: the driver has
 * to see it) and "this build no longer speaks the API's contract" (a route
 * renamed, a field made mandatory: an app update fixes it, and the item should
 * be sent again once the app is updated). A 404 for a missing route and the
 * 400s of the fueling and checklist routes carried no code at all, so every
 * one of them looked like the first kind.
 *
 * Every code travels in `x-error-code` as well as in the body: the route
 * response schemas strip unknown body fields, and the app reads the header
 * when the body has none.
 *
 * The same file checks the upgrade gate: off unless MIN_MOBILE_CONTRACT is
 * set, and even then only for builds that SAY which contract they speak. The
 * app build in drivers' hands today sends no version, and must never be
 * locked out by this.
 */
// Before any import: the env is parsed once, when `@/env` first loads, and the
// seed helper loads it through `@/config/auth`.
vi.hoisted(() => {
  process.env.MIN_MOBILE_CONTRACT = "10";
  process.env.MOBILE_STORE_URL =
    "https://play.google.com/store/apps/details?id=com.trajetto.fleetmanager";
});

const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let seed: FleetDriverSeed;
let uploads: UploadService;

const BUSINESS = "018fd990-0000-7000-8000-00000000000a";

const storedKeys: string[] = [];

const VERSION_HEADER = "x-trajetto-client-version";

// The native build number is informative only; the gate reads `contract`.
const build = (contract: number) =>
  `platform=android; version=1.4.0; build=999; runtime=abc123; update=embedded; contract=${contract}; outbox=1`;

async function storedPhoto(
  uploadType: "odometerPhotos" | "checklistPhotos",
): Promise<string> {
  const key = `${uploadType}/${BUSINESS}/${Date.now()}-contract-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

function fuelBody(mileage: number): Record<string, unknown> {
  return {
    client_submission_id: randomUUID(),
    current_mileage: mileage,
    liters_amount: 40,
    price_per_liter: 6,
    total_amount: 240,
    refueling_date: new Date(Date.now() - 60_000).toISOString(),
    vehicleId: seed.vehicleId,
    driverId: seed.driverId,
    fuelTypeId: seed.fuelTypeId,
    branchId: seed.branchId,
    businessId: BUSINESS,
    latitude: -23.55,
    longitude: -46.63,
    created_from: "MOBILE_APP",
  };
}

function checklistBody(overrides: Record<string, unknown> = {}) {
  const yes = Object.fromEntries(
    [
      "headlights_working",
      "taillights_working",
      "turn_signals_working",
      "seatbelts_working",
      "dashboard_working",
      "brakes_working",
      "clutch_working",
      "fuel_level_adequate",
      "oil_level_adequate",
      "radiator_water_adequate",
      "brake_fluid_adequate",
      "driver_license_valid",
      "vehicle_documents_valid",
      "insurance_valid",
      "fire_extinguisher_valid",
      "warning_triangle_present",
      "jack_present",
    ].map((field) => [field, true]),
  );

  const good = Object.fromEntries(
    [
      "tires_condition",
      "bumpers_condition",
      "windshield_condition",
      "mirrors_condition",
      "steering_wheel_condition",
      "battery_condition",
      "spare_tire_condition",
    ].map((field) => [field, "good"]),
  );

  return {
    client_submission_id: randomUUID(),
    vehicleId: seed.vehicleId,
    businessId: BUSINESS,
    branchId: seed.branchId,
    driverId: seed.driverId,
    checklist_date: new Date(Date.now() - 60_000).toISOString(),
    current_mileage: 5_000,
    overall_condition: "approved",
    ...yes,
    ...good,
    ...overrides,
  };
}

function post(url: string, payload: Record<string, unknown>, headers = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${seed.driverToken}`, ...headers },
    payload,
  });
}

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "55666777000515",
    mileage: 1_000,
  });

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");
}, 120_000);

afterAll(async () => {
  delete process.env.MIN_MOBILE_CONTRACT;
  delete process.env.MOBILE_STORE_URL;

  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a route that does not exist", () => {
  it("says so with a code, and keeps the body keys it always had", async () => {
    const response = await post("/delivery/start-route-v2/x", {});

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-error-code"]).toBe("ROUTE_NOT_FOUND");

    const body = response.json();

    expect(body.code).toBe("ROUTE_NOT_FOUND");
    expect(body.statusCode).toBe(404);
    expect(body.message).toEqual(expect.any(String));
  });
});

describe("the fueling route's refusals", () => {
  it("names a missing photo", async () => {
    const response = await post(`/fuel/create-fuel/${BUSINESS}`, fuelBody(1_100));

    expect(response.statusCode).toBe(400);
    expect(response.headers["x-error-code"]).toBe("PHOTO_REQUIRED");
  });

  it("names a mileage the vehicle's history refuses", async () => {
    const response = await post(`/fuel/create-fuel/${BUSINESS}`, {
      ...fuelBody(500),
      photo: { key: await storedPhoto("odometerPhotos") },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.headers["x-error-code"]).toBe("VEHICLE_MILEAGE_INVALID");
  });
});

describe("the checklist route's refusals", () => {
  it("names a body its schema refuses, and still says what was wrong", async () => {
    const response = await post(
      `/vehicle-checklist/create-vehicle-checklist/${BUSINESS}`,
      checklistBody({ tires_condition: "excellent" }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers["x-error-code"]).toBe("VALIDATION_ERROR");
    expect(response.json().message).toBe("Dados do formulário inválidos");
  });

  it("names missing photos", async () => {
    const response = await post(
      `/vehicle-checklist/create-vehicle-checklist/${BUSINESS}`,
      checklistBody(),
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers["x-error-code"]).toBe("PHOTOS_REQUIRED");
    expect(response.json().message).toBe("Fotos obrigatórias não fornecidas");
  });
});

describe("the upgrade gate (MIN_MOBILE_CONTRACT=10)", () => {
  const listVehicles = (headers: Record<string, string>) =>
    app.inject({
      method: "GET",
      url: `/vehicle/list-vehicle?page=1&pageSize=10`,
      headers: { authorization: `Bearer ${seed.driverToken}`, ...headers },
    });

  it("turns away a build below the minimum, with the minimum", async () => {
    const response = await listVehicles({ [VERSION_HEADER]: build(9) });

    expect(response.statusCode).toBe(426);
    expect(response.headers["x-error-code"]).toBe("CLIENT_UPGRADE_REQUIRED");

    const body = response.json();

    expect(body.code).toBe("CLIENT_UPGRADE_REQUIRED");
    expect(body.minContract).toBe(10);
    expect(body.message).toMatch(/Atualize o aplicativo Trajetto/);

    // MOBILE_STORE_URL, where the app goes when no over-the-air update fits.
    expect(body.storeUrl).toBe(
      "https://play.google.com/store/apps/details?id=com.trajetto.fleetmanager",
    );
  });

  it("lets the minimum build through", async () => {
    const response = await listVehicles({ [VERSION_HEADER]: build(10) });

    expect(response.statusCode).not.toBe(426);
  });

  it("never touches a client that does not say which build it is", async () => {
    // The app build in drivers' hands today, and the web.
    const response = await listVehicles({});

    expect(response.statusCode).not.toBe(426);
  });

  it("still lets an old build keep and end its session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/user/refresh-token",
      headers: { [VERSION_HEADER]: build(9) },
      payload: { refresh_token: "not-a-real-token" },
    });

    expect(response.statusCode).not.toBe(426);
  });
});
