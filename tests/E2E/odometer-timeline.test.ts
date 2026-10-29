import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A fueling that arrives after the records that came after it (GAP5-10).
 *
 * The odometer rule was "strictly more than the vehicle's current mileage",
 * checked against the vehicle as it is NOW, whatever the record's date. The
 * app's outbox sends a fueling queued without signal hours or days later —
 * and by then a checklist, or the manager on the web, has moved the odometer
 * past it. The fueling was refused for good: its cost, litres and photo
 * could never be entered, from the app or from the web.
 *
 * A record dated before the latest one is now held to the timeline instead:
 * its reading must sit strictly between the records around it in time. It
 * never lowers the vehicle's mileage. Everything the old rule accepted is
 * still accepted exactly as before.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let seed: FleetDriverSeed;
let uploads: UploadService;

const BUSINESS = "018fd980-0000-7000-8000-00000000000a";

const storedKeys: string[] = [];

const HOUR = 60 * 60 * 1000;

/** Hours before now, so no date is ever "in the future". */
const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * HOUR).toISOString();

async function storedPhoto(
  uploadType: "odometerPhotos" | "checklistPhotos",
): Promise<string> {
  const key = `${uploadType}/${BUSINESS}/${Date.now()}-timeline-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

async function fueling(mileage: number, at: string) {
  return app.inject({
    method: "POST",
    url: `/fuel/create-fuel/${BUSINESS}`,
    headers: { authorization: `Bearer ${seed.driverToken}` },
    payload: {
      client_submission_id: randomUUID(),
      current_mileage: mileage,
      liters_amount: 40,
      price_per_liter: 6,
      total_amount: 240,
      refueling_date: at,
      vehicleId: seed.vehicleId,
      driverId: seed.driverId,
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

async function checklist(mileage: number, at: string) {
  const photos = await Promise.all(
    ["current_mileage", "fuel_level_adequate", "tires_condition"].map(
      async (fieldName) => ({
        key: await storedPhoto("checklistPhotos"),
        fieldName,
      }),
    ),
  );

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

  return app.inject({
    method: "POST",
    url: `/vehicle-checklist/create-vehicle-checklist/${BUSINESS}`,
    headers: { authorization: `Bearer ${seed.driverToken}` },
    payload: {
      client_submission_id: randomUUID(),
      vehicleId: seed.vehicleId,
      businessId: BUSINESS,
      branchId: seed.branchId,
      driverId: seed.driverId,
      checklist_date: at,
      current_mileage: mileage,
      overall_condition: "approved",
      ...yes,
      ...good,
      photos,
    },
  });
}

async function vehicleMileage(): Promise<number> {
  return (
    await prisma.vehicle.findUniqueOrThrow({ where: { id: seed.vehicleId } })
  ).current_mileage;
}

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "55666777000434",
    mileage: 1_000,
  });

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");

  // The history the late records land in:
  //   10 h ago  fueling    1 100
  //    6 h ago  checklist  1 300   ← the vehicle reads 1 300 now
  expect((await fueling(1_100, hoursAgo(10))).statusCode).toBe(201);
  expect((await checklist(1_300, hoursAgo(6))).statusCode).toBe(201);
  expect(await vehicleMileage()).toBe(1_300);
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a fueling dated between two records, arriving late", () => {
  it("is recorded, and the vehicle keeps the later reading", async () => {
    const response = await fueling(1_200, hoursAgo(8));

    expect(response.statusCode, response.body).toBe(201);
    expect(await vehicleMileage()).toBe(1_300);

    const fuel = await prisma.fuel.findUniqueOrThrow({
      where: { id: response.json().id },
    });

    expect(fuel.current_mileage).toBe(1_200);
  });

  it("is refused when its reading is not above the record before it", async () => {
    // 8 h ago there is now a 1 200; 7 h ago cannot read 1 150.
    const response = await fueling(1_150, hoursAgo(7));

    expect(response.statusCode, response.body).toBe(400);
    expect(await vehicleMileage()).toBe(1_300);
  });

  it("is refused when its reading is not below the record after it", async () => {
    const response = await fueling(1_300, hoursAgo(7));

    expect(response.statusCode, response.body).toBe(400);
  });
});

describe("a checklist dated between two records, arriving late", () => {
  it("is recorded, and the vehicle keeps the later reading", async () => {
    const response = await checklist(1_250, hoursAgo(7));

    expect(response.statusCode, response.body).toBe(201);
    expect(await vehicleMileage()).toBe(1_300);
  });
});

/**
 * The checklist create ran the forward rule first ("above the odometer": move
 * it) and only then looked at the timeline, like the fueling create used to.
 * A checklist dated days ago with 5 000 typed for 1 250 went in and dragged
 * the odometer to 5 000, and every later fueling and checklist of the truck
 * was refused from then on. It is now placed by its date first
 * (placeReading), the fueling create's rule.
 */
describe("a checklist dated on an earlier day, typed above the later readings", () => {
  it("is refused, and the odometer does not jump", async () => {
    const response = await checklist(5_000, hoursAgo(72));

    expect(response.statusCode, response.body).toBe(400);
    expect(response.headers["x-error-code"]).toBe("VEHICLE_MILEAGE_INVALID");
    expect(await vehicleMileage()).toBe(1_300);
  });
});

describe("a record dated before the vehicle's first one", () => {
  it("is refused, whatever the records after it say", async () => {
    // The vehicle was registered at 1 000 km; nothing on its timeline says
    // so, and 500 km before the first fueling fits "below the next record".
    const response = await fueling(500, hoursAgo(12));

    expect(response.statusCode, response.body).toBe(400);
    expect(response.headers["x-error-code"]).toBe("VEHICLE_MILEAGE_INVALID");
    expect(await vehicleMileage()).toBe(1_300);
  });
});

describe("the newest record", () => {
  it("still has to move the odometer forward", async () => {
    const same = await fueling(1_300, hoursAgo(1));

    expect(same.statusCode, same.body).toBe(400);

    const ahead = await fueling(1_400, hoursAgo(1));

    expect(ahead.statusCode, ahead.body).toBe(201);
    expect(await vehicleMileage()).toBe(1_400);
  });
});
