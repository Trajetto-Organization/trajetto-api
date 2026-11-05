import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";
import { createPrismaClient } from "@/shared/database/database-client";
import { APP_SUBMISSION_KEY_REQUIRED } from "@/shared/vehicle/record-origin";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { readNdjson } from "./support/fleet-maint-seed";

/**
 * Where a checklist or a refuelling was made, over real HTTP and Postgres
 * (owner's test of the driver app, 05/11/2026: every checklist the app sent
 * showed "Web" in the panel; 20261105120000).
 *
 * - vehicle_checklist stores `created_from` and the list the web reads
 *   returns it: what the app sends is listed as MOBILE_APP, what the web's
 *   form sends (no origin) as WEB_DASHBOARD.
 * - A driver's record is MOBILE_APP whatever the body says
 *   (shared/vehicle/record-origin.ts). For a refuelling that brings the
 *   app's rules with it: the GPS point (400 LOCATION_REQUIRED) and the
 *   idempotency key (400 VALIDATION_ERROR, the schema's sentence and
 *   `issues`).
 * - Anybody else's checklist that names no origin is MOBILE_APP with a key,
 *   which only the app sends, and WEB_DASHBOARD without one.
 * - A resend of a recorded refuelling is still answered with it before any
 *   of that is looked at.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let uploads: UploadService;
const storedKeys: string[] = [];

const CARRIER = "018fec10-0000-7000-8000-00000000000a";

let carrier: FleetDriverSeed;

async function storedPhoto(
  folder: "odometerPhotos" | "checklistPhotos",
): Promise<string> {
  const key = `${folder}/${CARRIER}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

// Every record moves the odometer forward, the refused ones included.
let mileage = 1_000;

/** The answers both clients send; the origin and the key are the tests'. */
async function checklistBody(extra: Record<string, unknown> = {}) {
  const photos = await Promise.all(
    ["current_mileage", "fuel_level_adequate", "tires_condition"].map(
      async (fieldName) => ({
        key: await storedPhoto("checklistPhotos"),
        fieldName,
      }),
    ),
  );

  mileage += 10;

  return {
    vehicleId: carrier.vehicleId,
    branchId: carrier.branchId,
    driverId: carrier.driverId,
    checklist_date: new Date(Date.now() - 60_000).toISOString(),
    current_mileage: mileage,
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
    ...extra,
  };
}

/** What the web's form posts: WEB_DASHBOARD, no key, no GPS. */
async function webFuelBody(extra: Record<string, unknown> = {}) {
  const key = await storedPhoto("odometerPhotos");

  mileage += 10;

  return {
    current_mileage: mileage,
    liters_amount: 50,
    price_per_liter: 6.5,
    refueling_date: new Date(Date.now() - 60_000).toISOString(),
    businessId: CARRIER,
    vehicleId: carrier.vehicleId,
    driverId: carrier.driverId,
    fuelTypeId: carrier.fuelTypeId,
    branchId: carrier.branchId,
    created_from: "WEB_DASHBOARD",
    photo: { key },
    ...extra,
  };
}

const GPS = { latitude: -23.55, longitude: -46.63 };

const post = (url: string, token: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

const checklistUrl = `/vehicle-checklist/create-vehicle-checklist/${CARRIER}`;
const fuelUrl = `/fuel/create-fuel/${CARRIER}`;

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "77888999000101",
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
});

describe("a checklist's origin", () => {
  it("is MOBILE_APP for what the app sends, in the list the web reads", async () => {
    const response = await post(
      checklistUrl,
      carrier.driverToken,
      await checklistBody({
        client_submission_id: randomUUID(),
        created_from: "MOBILE_APP",
      }),
    );

    expect(response.statusCode, response.body).toBe(201);

    const id = response.json().id;
    const list = await readNdjson<{ id: string; created_from: string }>(
      app,
      "/vehicle-checklist/list-vehicle-checklist?page=1&pageSize=50",
      carrier.managerToken,
    );

    expect(list.status, list.body).toBe(200);
    expect(list.rows.find((row) => row.id === id)?.created_from).toBe(
      "MOBILE_APP",
    );

    // The activity trail is written from this event: "Origem: Aplicativo".
    const event = await prisma.domainOutboxEvent.findFirstOrThrow({
      where: { aggregateId: id, topic: "vehicle-checklist.created" },
    });

    expect(event.payload).toMatchObject({ origin: "MOBILE_APP" });
  });

  it("is WEB_DASHBOARD for a manager's checklist that names none (the web's form)", async () => {
    const response = await post(
      checklistUrl,
      carrier.managerToken,
      await checklistBody(),
    );

    expect(response.statusCode, response.body).toBe(201);

    const row = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: response.json().id },
    });

    expect(row.created_from).toBe("WEB_DASHBOARD");
    expect(row.client_submission_id).toBeNull();
  });

  it("is MOBILE_APP for a manager's checklist that names none but carries the key (the app build in use)", async () => {
    const key = randomUUID();

    // The key only in the Idempotency-Key header: the controller copies it.
    const response = await app.inject({
      method: "POST",
      url: checklistUrl,
      headers: {
        authorization: `Bearer ${carrier.managerToken}`,
        "idempotency-key": key,
      },
      payload: await checklistBody(),
    });

    expect(response.statusCode, response.body).toBe(201);

    const id = response.json().id;
    const row = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id },
    });

    expect(row).toMatchObject({
      created_from: "MOBILE_APP",
      client_submission_id: key,
    });

    const event = await prisma.domainOutboxEvent.findFirstOrThrow({
      where: { aggregateId: id, topic: "vehicle-checklist.created" },
    });

    expect(event.payload).toMatchObject({ origin: "MOBILE_APP" });
  });

  it("is MOBILE_APP for a driver whose body says WEB_DASHBOARD", async () => {
    const response = await post(
      checklistUrl,
      carrier.driverToken,
      await checklistBody({
        client_submission_id: randomUUID(),
        created_from: "WEB_DASHBOARD",
      }),
    );

    expect(response.statusCode, response.body).toBe(201);

    const id = response.json().id;
    const row = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id },
    });

    expect(row.created_from).toBe("MOBILE_APP");

    const event = await prisma.domainOutboxEvent.findFirstOrThrow({
      where: { aggregateId: id, topic: "vehicle-checklist.created" },
    });

    expect(event.payload).toMatchObject({ origin: "MOBILE_APP" });
  });
});

describe("a driver's refuelling that says WEB_DASHBOARD", () => {
  it("is refused without the GPS point, as the app's", async () => {
    const before = await prisma.fuel.count({ where: { businessId: CARRIER } });

    const response = await post(
      fuelUrl,
      carrier.driverToken,
      await webFuelBody({ client_submission_id: randomUUID() }),
    );

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      code: "LOCATION_REQUIRED",
      message:
        "Para registros via aplicativo mobile, a localização é obrigatória.",
    });
    expect(response.headers["x-error-code"]).toBe("LOCATION_REQUIRED");
    expect(await prisma.fuel.count({ where: { businessId: CARRIER } })).toBe(
      before,
    );
  });

  it("is refused without the key, with the schema's code and sentence", async () => {
    const before = await prisma.fuel.count({ where: { businessId: CARRIER } });

    // No client_submission_id and no Idempotency-Key header.
    const response = await post(
      fuelUrl,
      carrier.driverToken,
      await webFuelBody(GPS),
    );

    expect(response.statusCode, response.body).toBe(400);
    // The error contract of every 400 VALIDATION_ERROR: one sentence per
    // refused field in `issues`, as the schema's own refusal.
    expect(response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      message: APP_SUBMISSION_KEY_REQUIRED,
      issues: [APP_SUBMISSION_KEY_REQUIRED],
    });
    expect(response.headers["x-error-code"]).toBe("VALIDATION_ERROR");
    expect(await prisma.fuel.count({ where: { businessId: CARRIER } })).toBe(
      before,
    );
  });

  it("with both, is stored as the app's", async () => {
    const response = await post(
      fuelUrl,
      carrier.driverToken,
      await webFuelBody({ ...GPS, client_submission_id: randomUUID() }),
    );

    expect(response.statusCode, response.body).toBe(201);

    const row = await prisma.fuel.findUniqueOrThrow({
      where: { id: response.json().id },
    });

    expect(row).toMatchObject({
      created_from: "MOBILE_APP",
      location_source: "GPS_AUTO",
      location_edited_by: null,
    });
  });

  it("is answered with the refuelling already recorded under its key, before any rule", async () => {
    const key = randomUUID();

    const first = await post(
      fuelUrl,
      carrier.driverToken,
      await webFuelBody({
        ...GPS,
        client_submission_id: key,
        created_from: "MOBILE_APP",
      }),
    );

    expect(first.statusCode, first.body).toBe(201);

    // The same submission resent with a body the rules would refuse.
    const resend = await post(
      fuelUrl,
      carrier.driverToken,
      await webFuelBody({ client_submission_id: key }),
    );

    expect(resend.statusCode, resend.body).toBe(201);
    expect(resend.json().id).toBe(first.json().id);
    expect(
      await prisma.fuel.count({
        where: { businessId: CARRIER, client_submission_id: key },
      }),
    ).toBe(1);
  });
});

describe("a manager's refuelling", () => {
  it("keeps WEB_DASHBOARD with no key and no GPS (the web's form)", async () => {
    const response = await post(
      fuelUrl,
      carrier.managerToken,
      await webFuelBody(),
    );

    expect(response.statusCode, response.body).toBe(201);

    const row = await prisma.fuel.findUniqueOrThrow({
      where: { id: response.json().id },
    });

    expect(row).toMatchObject({
      created_from: "WEB_DASHBOARD",
      location_source: "NONE",
      client_submission_id: null,
    });
  });
});
