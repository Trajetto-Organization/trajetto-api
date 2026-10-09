import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";
import { businessDateKey, businessDayStart } from "@/shared/time/business-day";

import { fakeJpeg, seedFleetDriver, type FleetDriverSeed } from "./support/fleet-driver-seed";
import { seedCarrier, seedProfile, seedUser } from "./support/fleet-maint-seed";

/**
 * Fleet records dated with a bare day ("YYYY-MM-DD"), over HTTP and Postgres.
 *
 * - The fueling and service-order creates passed the schema with a day and
 *   then failed in Prisma (DateTime wants a full ISO value): 500.
 * - The checklist turned the day into 00:00 UTC, the evening before in
 *   Brazil, so it was placed before the same day's readings and a valid km
 *   was refused with VEHICLE_MILEAGE_INVALID.
 * - The first service order of a vehicle that never had a review needed a
 *   last-review km nobody has (400 for everyone but a MASTER).
 *
 * A day is now stored as the instant it starts in the company's zone, the
 * instant the web's picker sends.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let seed: FleetDriverSeed;
let uploads: UploadService;

const BUSINESS = "018fe9a0-0000-7000-8000-00000000000a";
const OTHER = "018fe9a0-0000-7000-8000-00000000000b";
const ZONE = "America/Sao_Paulo";

const storedKeys: string[] = [];
const tokens = { otherAdmin: "", fleetUser: "", readOnly: "" };
let responsibleUserId = "";

let today = "";

async function storedPhoto(kind: "odometerPhotos" | "checklistPhotos"): Promise<string> {
  const key = `${kind}/${BUSINESS}/${Date.now()}-dia-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

const send = (method: "POST" | "PATCH", url: string, payload: object, token = seed.managerToken) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

/** A truck of its own per case, so each timeline stands alone. */
async function truck(mileage: number): Promise<string> {
  const base = await prisma.vehicle.findUniqueOrThrow({ where: { id: seed.vehicleId } });
  const created = await prisma.vehicle.create({
    data: {
      license_plate: randomUUID().slice(0, 7).toUpperCase(),
      description: "Caminhão do dia",
      brand: base.brand,
      model: base.model,
      acquisition_date: base.acquisition_date,
      fleet_type: base.fleet_type,
      current_mileage: mileage,
      maintenance_interval_km: 10_000,
      maintenance_interval_months: 6,
      renavam: randomUUID().slice(0, 11),
      manufacturing_year: base.manufacturing_year,
      model_year: base.model_year,
      km_per_liter: 3,
      number_of_axles: 2,
      status: "ACTIVE",
      businessId: BUSINESS,
      branchId: seed.branchId,
      fuelTypeId: seed.fuelTypeId,
      last_maintenance_mileage: null,
    },
  });

  return created.id;
}

const mileageOf = async (vehicleId: string) =>
  (await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).current_mileage;

async function fueling(vehicleId: string, mileage: number, refueling_date: string) {
  return send("POST", `/fuel/create-fuel/${BUSINESS}`, {
    current_mileage: mileage,
    liters_amount: 40,
    price_per_liter: 5.899,
    refueling_date,
    businessId: BUSINESS,
    created_from: "WEB_DASHBOARD",
    branchId: seed.branchId,
    vehicleId,
    driverId: seed.driverId,
    fuelTypeId: seed.fuelTypeId,
    photo: { key: await storedPhoto("odometerPhotos") },
  });
}

async function checklist(vehicleId: string, mileage: number, checklist_date: string) {
  const photos = await Promise.all(
    ["current_mileage", "fuel_level_adequate", "tires_condition"].map(async (fieldName) => ({
      key: await storedPhoto("checklistPhotos"),
      fieldName,
    })),
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

  return send("POST", `/vehicle-checklist/create-vehicle-checklist/${BUSINESS}`, {
    vehicleId,
    businessId: BUSINESS,
    branchId: seed.branchId,
    driverId: seed.driverId,
    checklist_date,
    current_mileage: mileage,
    overall_condition: "approved",
    ...yes,
    ...good,
    photos,
  });
}

const orderBody = (vehicleId: string, extra: Record<string, unknown> = {}) => ({
  date: today,
  maintenance_type: "EXTERNAL",
  total_amount: 350,
  current_mileage_at_service: 10_000,
  maintenance_interval_km_at_service: 10_000,
  vehicleId,
  branchId: seed.branchId,
  responsibleUserId,
  created_from: "WEB_DASHBOARD",
  ...extra,
});

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, { businessId: BUSINESS, cnpj: "55666777000515" });

  const fleetUser = await seedUser(prisma, "Frota", "BUSINESS_USER", BUSINESS, {
    profileAccessId: await seedProfile(prisma, BUSINESS, [
      { key: "service_order_manage", write: true },
      { key: "vehicle_manage", write: false },
    ]),
  });

  tokens.fleetUser = fleetUser.token;
  responsibleUserId = fleetUser.id;
  tokens.readOnly = (
    await seedUser(prisma, "Leitura", "BUSINESS_USER", BUSINESS, {
      profileAccessId: await seedProfile(prisma, BUSINESS, [
        { key: "service_order_manage", write: false },
      ]),
    })
  ).token;

  await seedCarrier(prisma, OTHER);
  tokens.otherAdmin = (await seedUser(prisma, "Outra", "BUSINESS_ADMIN", OTHER)).token;

  today = businessDateKey(new Date(), ZONE);

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("POST /fuel/create-fuel with a bare day", () => {
  it("is stored at the start of that day in the company's zone (was 500)", async () => {
    const vehicleId = await truck(50_000);
    const response = await fueling(vehicleId, 50_100, today);

    expect(response.statusCode, response.body).toBe(201);

    const fuel = await prisma.fuel.findFirstOrThrow({ where: { vehicleId } });

    expect(fuel.refueling_date.toISOString()).toBe(businessDayStart(today, ZONE).toISOString());
    expect(await mileageOf(vehicleId)).toBe(50_100);
  });

  it("is also accepted by the edit", async () => {
    const vehicleId = await truck(60_000);
    const created = await fueling(vehicleId, 60_100, new Date(Date.now() - 60_000).toISOString());

    expect(created.statusCode, created.body).toBe(201);

    const edit = await send("PATCH", `/fuel/update-fuel/${created.json().id}/business/${BUSINESS}`, {
      refueling_date: today,
    });

    expect(edit.statusCode, edit.body).toBe(200);

    const fuel = await prisma.fuel.findUniqueOrThrow({ where: { id: created.json().id } });

    expect(fuel.refueling_date.toISOString()).toBe(businessDayStart(today, ZONE).toISOString());
  });

  it("refuses a day that does not exist", async () => {
    const vehicleId = await truck(70_000);
    const response = await fueling(vehicleId, 70_100, "2026-02-30");

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /vehicle-checklist/create-vehicle-checklist with a bare day", () => {
  it("passes a reading above the one recorded earlier the same day", async () => {
    const vehicleId = await truck(80_000);

    // A record one second into the company's today, as the app leaves it.
    await prisma.fuel.create({
      data: {
        current_mileage: 80_100,
        liters_amount: 40,
        price_per_liter: 5,
        total_amount: 200,
        odometer_photo: `odometerPhotos/${BUSINESS}/cedo.webp`,
        refueling_date: new Date(businessDayStart(today, ZONE).getTime() + 1_000),
        businessId: BUSINESS,
        branchId: seed.branchId,
        vehicleId,
        driverId: seed.driverId,
        fuelTypeId: seed.fuelTypeId,
        created_from: "MOBILE_APP",
      },
    });
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { current_mileage: 80_100 } });

    // Red before: placed at 00:00 UTC (yesterday evening in São Paulo), so
    // this morning's 80 100 was "a later day" and 80 200 was refused.
    const response = await checklist(vehicleId, 80_200, today);

    expect(response.statusCode, response.body).toBe(201);
    expect(await mileageOf(vehicleId)).toBe(80_200);

    const stored = await prisma.vehicleChecklist.findFirstOrThrow({ where: { vehicleId } });

    expect(stored.checklist_date.toISOString()).toBe(businessDayStart(today, ZONE).toISOString());
  });
});

describe("POST /service-order/create-service-order", () => {
  it("creates the first order of a vehicle without a previous review, as a manager", async () => {
    const vehicleId = await truck(10_000);

    // Red before: 400 (last_maintenance_mileage_at_service required) and,
    // with it, 500 for the bare day.
    const response = await send("POST", `/service-order/create-service-order/${BUSINESS}`, orderBody(vehicleId));

    expect(response.statusCode, response.body).toBe(201);

    const order = await prisma.serviceOrder.findFirstOrThrow({ where: { vehicleId } });

    expect(order.last_maintenance_mileage_at_service).toBeNull();
    expect(order.date.toISOString()).toBe(businessDayStart(today, ZONE).toISOString());
  });

  it("creates it for a company user with write on service orders, and the edit takes a bare day", async () => {
    const vehicleId = await truck(10_000);
    const created = await send(
      "POST",
      `/service-order/create-service-order/${BUSINESS}`,
      orderBody(vehicleId),
      tokens.fleetUser,
    );

    expect(created.statusCode, created.body).toBe(201);

    const order = await prisma.serviceOrder.findFirstOrThrow({ where: { vehicleId } });
    const edit = await send(
      "PATCH",
      `/service-order/update-service-order/${order.id}/business/${BUSINESS}`,
      { date: today, description: "Primeira revisão" },
      tokens.fleetUser,
    );

    expect(edit.statusCode, edit.body).toBe(200);
  });

  it("still refuses a read-only profile and another company", async () => {
    const vehicleId = await truck(10_000);

    const readOnly = await send(
      "POST",
      `/service-order/create-service-order/${BUSINESS}`,
      orderBody(vehicleId),
      tokens.readOnly,
    );

    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().code).toBe("PERMISSION_DENIED");

    const foreign = await send(
      "POST",
      `/service-order/create-service-order/${BUSINESS}`,
      orderBody(vehicleId),
      tokens.otherAdmin,
    );

    expect(foreign.statusCode).toBe(403);
    expect(await prisma.serviceOrder.count({ where: { vehicleId } })).toBe(0);
  });
});
