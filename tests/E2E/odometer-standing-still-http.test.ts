import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";
import { createPrismaClient } from "@/shared/database/database-client";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * The odometer stands still for a short while (owner, 05/11/2026), over real
 * HTTP and Postgres: the neighbours' records come from the four timeline
 * reads (odometerNeighbours), across refuellings and checklists.
 *
 * The question "Já tem um abastecimento recente" offers "Segundo tanque",
 * "Completar o tanque", "A bomba parou antes": all at the same stop, the
 * same km, and the strict rule made the driver type 1 km more. A reading may
 * now EQUAL the one before or after it when that record is less than 30
 * minutes away (neither date only a day). The second refuelling is still
 * asked about (409 FUEL_RECENT_REFUEL) and flagged; an equal reading never
 * moves the odometer forward, and only the correction of the record that set
 * it brings it down, to the highest reading left; 30 minutes or more apart,
 * the strict rule (400 VEHICLE_MILEAGE_INVALID).
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let uploads: UploadService;
let seed: FleetDriverSeed;

const BUSINESS = "018fec22-0000-7000-8000-00000000000a";

const CONTRACT_5 =
  "platform=android; version=1.5.0; build=50; runtime=e2e; update=embedded; contract=5; outbox=1";

/** A build that asks before a second refuelling, sending now. */
const ASKS = { "x-trajetto-client-version": CONTRACT_5 };

/** The same build's offline queue, delivering what was tapped at `date`. */
const queuedAt = (date: string) => ({ ...ASKS, "x-client-queued-at": date });

const storedKeys: string[] = [];

/**
 * Two hours apart per scenario, all in the past and in date order: each
 * scenario's first record is the vehicle's newest, with the highest km, and
 * no scenario sits inside another's 30-minute windows.
 */
const BASE = Date.now() - 24 * 60 * 60 * 1000;
let scenario = 0;

function nextSlot(): number {
  scenario += 1;

  return BASE + scenario * 2 * 60 * 60 * 1000;
}

const at = (slot: number, minutes: number) =>
  new Date(slot + minutes * 60_000).toISOString();

/** Each scenario's km, above every earlier one. */
let km = 1_000;

function nextKm(): number {
  km += 100;

  return km;
}

async function storedPhoto(
  uploadType: "odometerPhotos" | "checklistPhotos",
): Promise<string> {
  const key = `${uploadType}/${BUSINESS}/${Date.now()}-still-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

/** What the app sends for a refuelling tapped at `date`. */
async function refuel(
  mileage: number,
  date: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: `/fuel/create-fuel/${BUSINESS}`,
    headers: { authorization: `Bearer ${seed.driverToken}`, ...headers },
    payload: {
      client_submission_id: randomUUID(),
      current_mileage: mileage,
      liters_amount: 40,
      price_per_liter: 6,
      refueling_date: date,
      vehicleId: seed.vehicleId,
      fuelTypeId: seed.fuelTypeId,
      businessId: BUSINESS,
      latitude: -23.55,
      longitude: -46.63,
      created_from: "MOBILE_APP",
      photo: { key: await storedPhoto("odometerPhotos") },
      ...extra,
    },
  });
}

/** What the app sends for the driver's checklist made at `date`. */
async function checklist(mileage: number, date: string) {
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
    headers: { authorization: `Bearer ${seed.driverToken}`, ...ASKS },
    payload: {
      client_submission_id: randomUUID(),
      vehicleId: seed.vehicleId,
      businessId: BUSINESS,
      branchId: seed.branchId,
      driverId: seed.driverId,
      checklist_date: date,
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

const fuelRow = (response: { json: () => { id: string } }) =>
  prisma.fuel.findUniqueOrThrow({ where: { id: response.json().id } });

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "77888999000393",
    mileage: 1_000,
  });

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a second refuelling at the stop, at the first one's km", () => {
  it("is asked about, then recorded 10 minutes later with RECENT_REFUEL, the odometer unchanged", async () => {
    const slot = nextSlot();
    const mileage = nextKm();

    const first = await refuel(mileage, at(slot, 0), {}, ASKS);

    expect(first.statusCode, first.body).toBe(201);
    expect(await vehicleMileage()).toBe(mileage);

    // The point-3 question first, unchanged.
    const asked = await refuel(mileage, at(slot, 10), {}, ASKS);

    expect(asked.statusCode, asked.body).toBe(409);
    expect(asked.headers["x-error-code"]).toBe("FUEL_RECENT_REFUEL");

    const second = await refuel(
      mileage,
      at(slot, 10),
      { confirm_recent: true, recent_reason: "Segundo tanque" },
      ASKS,
    );

    expect(second.statusCode, second.body).toBe(201);
    expect(await fuelRow(second)).toMatchObject({
      current_mileage: mileage,
      alerts: ["RECENT_REFUEL"],
      recent_refuel_previous_at: new Date(at(slot, 0)),
      recent_refuel_reason: "Segundo tanque",
    });
    expect(await vehicleMileage()).toBe(mileage);
  });
});

describe("a refuelling and a checklist of the same stop", () => {
  it("records the refuelling 5 minutes after the checklist, at its km", async () => {
    const slot = nextSlot();
    const mileage = nextKm();

    const inspected = await checklist(mileage, at(slot, 0));

    expect(inspected.statusCode, inspected.body).toBe(201);

    const fuel = await refuel(mileage, at(slot, 5));

    expect(fuel.statusCode, fuel.body).toBe(201);
    expect(await fuelRow(fuel)).toMatchObject({
      current_mileage: mileage,
      alerts: [],
    });
    expect(await vehicleMileage()).toBe(mileage);
  });

  it("records the checklist 10 minutes after the refuelling, at its km", async () => {
    const slot = nextSlot();
    const mileage = nextKm();

    expect((await refuel(mileage, at(slot, 0))).statusCode).toBe(201);

    const inspected = await checklist(mileage, at(slot, 10));

    expect(inspected.statusCode, inspected.body).toBe(201);
    expect(await vehicleMileage()).toBe(mileage);
  });

  it("refuses the same km 31 minutes later: 400 VEHICLE_MILEAGE_INVALID", async () => {
    const slot = nextSlot();
    const mileage = nextKm();

    expect((await refuel(mileage, at(slot, 0))).statusCode).toBe(201);

    const inspected = await checklist(mileage, at(slot, 31));

    expect(inspected.statusCode, inspected.body).toBe(400);
    expect(inspected.headers["x-error-code"]).toBe("VEHICLE_MILEAGE_INVALID");
    expect(inspected.json().message).toContain(
      "menos de 30 minutos de diferença",
    );

    const fuel = await refuel(mileage, at(slot, 31), {}, ASKS);

    expect(fuel.statusCode, fuel.body).toBe(400);
    expect(fuel.headers["x-error-code"]).toBe("VEHICLE_MILEAGE_INVALID");
    expect(await vehicleMileage()).toBe(mileage);
  });
});

describe("a refuelling the offline queue delivers after a later record of the same km", () => {
  it("is recorded, and the odometer stays", async () => {
    const slot = nextSlot();
    const mileage = nextKm();

    // The checklist of :10 reached the server first; the refuelling tapped
    // at :00 without signal arrives now.
    expect((await checklist(mileage, at(slot, 10))).statusCode).toBe(201);
    expect(await vehicleMileage()).toBe(mileage);

    const late = await refuel(mileage, at(slot, 0), {}, queuedAt(at(slot, 0)));

    expect(late.statusCode, late.body).toBe(201);
    expect(await fuelRow(late)).toMatchObject({
      current_mileage: mileage,
      alerts: [],
    });
    expect(await vehicleMileage()).toBe(mileage);
  });

  it("is refused 40 minutes before it: the strict rule", async () => {
    const slot = nextSlot();
    const mileage = nextKm();

    expect((await checklist(mileage, at(slot, 40))).statusCode).toBe(201);

    const late = await refuel(mileage, at(slot, 0), {}, queuedAt(at(slot, 0)));

    expect(late.statusCode, late.body).toBe(400);
    expect(late.headers["x-error-code"]).toBe("VEHICLE_MILEAGE_INVALID");
    expect(await vehicleMileage()).toBe(mileage);
  });
});

describe("the office corrects the second tank typed 1 km more", () => {
  it("takes the first tank's km, and the odometer the typo set comes down to it", async () => {
    const slot = nextSlot();
    const mileage = nextKm();

    expect((await refuel(mileage, at(slot, 0))).statusCode).toBe(201);

    const typo = await refuel(mileage + 1, at(slot, 10));

    expect(typo.statusCode, typo.body).toBe(201);
    expect(await vehicleMileage()).toBe(mileage + 1);

    const corrected = await app.inject({
      method: "PATCH",
      url: `/fuel/update-fuel/${typo.json().id}/business/${BUSINESS}`,
      headers: { authorization: `Bearer ${seed.managerToken}` },
      payload: { current_mileage: String(mileage) },
    });

    expect(corrected.statusCode, corrected.body).toBe(200);
    expect((await fuelRow(typo)).current_mileage).toBe(mileage);
    expect(await vehicleMileage()).toBe(mileage);
  });
});
