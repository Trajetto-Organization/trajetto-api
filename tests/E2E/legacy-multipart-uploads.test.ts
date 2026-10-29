import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import pino from "pino";

import { promises as fs } from "node:fs";
import path from "node:path";

import { uploadConfig } from "@/config/upload";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The app build that is in drivers' hands today, posting the way it posts.
 *
 * The only binary the mobile repository's `main` can produce sends a fueling
 * and a checklist as multipart, photos included — it predates presigned
 * uploads, and a new binary has to pass store review and be installed before
 * it replaces it. This API had stopped parsing multipart, so from the day it
 * was deployed every one of those submissions failed, retry after retry.
 *
 * These two routes accept it again, for as long as that build is out there.
 * The bytes go to storage under the same namespace the presigned flow uses,
 * and from there on it is the presigned path: same guards, same idempotency,
 * same checks. Every other route still refuses multipart.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let seed: FleetDriverSeed;

const BUSINESS = "018fd970-0000-7000-8000-00000000000a";

/** What React Native's fetch sends for a FormData body. */
const BOUNDARY = `----RNFormDataBoundary${randomUUID().slice(0, 8)}`;

type Part =
  | { name: string; value: string }
  | { name: string; filename: string; type: string; bytes: Buffer };

function multipart(parts: Part[]): Buffer {
  const chunks: Buffer[] = [];

  for (const part of parts) {
    const header =
      "bytes" in part
        ? `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type}\r\n\r\n`
        : `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n`;

    chunks.push(Buffer.from(header, "utf8"));
    chunks.push("bytes" in part ? part.bytes : Buffer.from(part.value, "utf8"));
    chunks.push(Buffer.from("\r\n"));
  }

  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));

  return Buffer.concat(chunks);
}

/** use-fuel.ts on `main`: every field as a string, then the photo. */
function legacyFuel(
  mileage: number,
  submissionId: string,
  overrides: Record<string, string> = {},
  photo: Buffer = fakeJpeg(),
): Buffer {
  const fields: Record<string, string> = {
    current_mileage: String(mileage),
    liters_amount: "50",
    price_per_liter: "6.5",
    total_amount: "325",
    refueling_date: new Date(Date.now() - 60_000).toISOString(),
    vehicleId: seed.vehicleId,
    driverId: seed.driverId,
    fuelTypeId: seed.fuelTypeId,
    branchId: seed.branchId,
    businessId: BUSINESS,
    client_submission_id: submissionId,
    created_from: "MOBILE_APP",
    latitude: "-23.55",
    longitude: "-46.63",
    ...overrides,
  };

  return multipart([
    ...Object.entries(fields).map(([name, value]) => ({ name, value })),
    {
      name: "odometer_photo",
      filename: `odometer_${Date.now()}.jpg`,
      type: "image/jpeg",
      bytes: photo,
    },
  ]);
}

/**
 * use-checklist.ts on `main`: the answers, then each photo under the name of
 * the question it documents — `current_mileage` is BOTH a field and a photo
 * part — then the submission id.
 */
function legacyChecklist(
  mileage: number,
  submissionId: string,
  overrides: Record<string, string> = {},
): Buffer {
  const answers: Record<string, string> = {
    vehicleId: seed.vehicleId,
    businessId: BUSINESS,
    branchId: seed.branchId,
    driverId: seed.driverId,
    checklist_date: new Date(Date.now() - 60_000).toISOString(),
    current_mileage: String(mileage),
    headlights_working: "true",
    taillights_working: "true",
    turn_signals_working: "true",
    seatbelts_working: "true",
    dashboard_working: "true",
    brakes_working: "true",
    clutch_working: "true",
    fuel_level_adequate: "true",
    oil_level_adequate: "true",
    radiator_water_adequate: "true",
    brake_fluid_adequate: "true",
    driver_license_valid: "true",
    vehicle_documents_valid: "true",
    insurance_valid: "true",
    fire_extinguisher_valid: "true",
    warning_triangle_present: "true",
    jack_present: "true",
    tires_condition: "good",
    bumpers_condition: "good",
    windshield_condition: "good",
    mirrors_condition: "good",
    steering_wheel_condition: "good",
    battery_condition: "good",
    spare_tire_condition: "good",
    overall_condition: "approved",
    ...overrides,
  };

  return multipart([
    ...Object.entries(answers).map(([name, value]) => ({ name, value })),
    ...["current_mileage", "fuel_level_adequate", "tires_condition"].map(
      (fieldName, index) => ({
        name: fieldName,
        filename: `${fieldName}_${Date.now()}_${index}.jpg`,
        type: "image/jpeg",
        bytes: fakeJpeg(1_024 + index),
      }),
    ),
    { name: "client_submission_id", value: submissionId },
  ]);
}

function postMultipart(url: string, payload: Buffer, submissionId: string) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${seed.driverToken}`,
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      "idempotency-key": submissionId,
      "user-agent": "okhttp/4.9.2",
    },
    payload,
  });
}

const fuelUrl = () => `/fuel/create-fuel/${BUSINESS}`;
const checklistUrl = () =>
  `/vehicle-checklist/create-vehicle-checklist/${BUSINESS}`;

/** Every object this business has under one upload type, on local storage. */
async function storedObjects(uploadType: string): Promise<string[]> {
  const directory = path.join(
    uploadConfig.storage.localPath,
    uploadType,
    BUSINESS,
  );

  try {
    return (await fs.readdir(directory)).map(
      (name) => `${uploadType}/${BUSINESS}/${name}`,
    );
  } catch {
    return [];
  }
}

async function vehicleMileage(): Promise<number> {
  return (
    await prisma.vehicle.findUniqueOrThrow({ where: { id: seed.vehicleId } })
  ).current_mileage;
}

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "55666777000272",
    mileage: 1_000,
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  for (const uploadType of ["odometerPhotos", "checklistPhotos"]) {
    await fs.rm(
      path.join(uploadConfig.storage.localPath, uploadType, BUSINESS),
      {
        recursive: true,
        force: true,
      },
    );
  }

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a fueling posted as multipart by the app build in drivers' hands", () => {
  it("is recorded, with the photo in storage where the presigned flow puts it", async () => {
    const key = randomUUID();

    const response = await postMultipart(
      fuelUrl(),
      legacyFuel(1_100, key),
      key,
    );

    expect(response.statusCode, response.body).toBe(201);

    const fuel = await prisma.fuel.findUniqueOrThrow({
      where: { id: response.json().id },
    });

    expect(fuel.client_submission_id).toBe(key);
    expect(fuel.current_mileage).toBe(1_100);
    expect(fuel.odometer_photo).toMatch(
      new RegExp(`^odometerPhotos/${BUSINESS}/.+\\.jpg$`),
    );
    expect(await storedObjects("odometerPhotos")).toContain(
      fuel.odometer_photo,
    );
    expect(await vehicleMileage()).toBe(1_100);
  });

  it("answers a resend with the same record, and stores no second photo", async () => {
    const key = randomUUID();
    const mileage = (await vehicleMileage()) + 100;

    const first = await postMultipart(fuelUrl(), legacyFuel(mileage, key), key);
    expect(first.statusCode, first.body).toBe(201);

    const before = await storedObjects("odometerPhotos");

    const resend = await postMultipart(
      fuelUrl(),
      legacyFuel(mileage, key),
      key,
    );

    expect(resend.statusCode, resend.body).toBe(201);
    expect(resend.json().id).toBe(first.json().id);
    expect(
      await prisma.fuel.count({ where: { client_submission_id: key } }),
    ).toBe(1);
    expect(await storedObjects("odometerPhotos")).toEqual(before);
  });

  it("goes through the branch guard, which reads the branch from the multipart fields", async () => {
    const inactive = await prisma.branch.create({
      data: {
        corporate_reason: `Filial Inativa ${randomUUID().slice(0, 6)}`,
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        cnpj: "55666777000353",
        cnae: "4930202",
        responsible_name: "Responsável",
        telephone: "11999999999",
        email: `inativa-${randomUUID()}@exemplo.com.br`,
        businessId: BUSINESS,
        is_active: false,
      },
    });

    const before = await storedObjects("odometerPhotos");
    const key = randomUUID();

    const response = await postMultipart(
      fuelUrl(),
      legacyFuel((await vehicleMileage()) + 100, key, {
        branchId: inactive.id,
      }),
      key,
    );

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("BRANCH_INACTIVE");

    // Refused before a single byte reached storage.
    expect(await storedObjects("odometerPhotos")).toEqual(before);
  });

  it("refuses a part that is not an image, and keeps nothing", async () => {
    const before = await storedObjects("odometerPhotos");
    const key = randomUUID();

    const response = await postMultipart(
      fuelUrl(),
      legacyFuel(
        (await vehicleMileage()) + 100,
        key,
        {},
        Buffer.from("<script>alert(1)</script>"),
      ),
      key,
    );

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("UNSUPPORTED_FILE_TYPE");
    expect(await storedObjects("odometerPhotos")).toEqual(before);
  });

  it("removes the photo it stored when the fueling itself is refused", async () => {
    const before = await storedObjects("odometerPhotos");
    const key = randomUUID();

    // Below the vehicle's odometer: a verdict on the fueling, final.
    const response = await postMultipart(fuelUrl(), legacyFuel(10, key), key);

    expect(response.statusCode, response.body).toBe(400);

    // Removed after the answer is sent, so the driver never waits on it.
    await vi.waitFor(async () => {
      expect(await storedObjects("odometerPhotos")).toEqual(before);
    });
  });
});

describe("a checklist posted as multipart by the app build in drivers' hands", () => {
  it("is recorded, each photo filed under the question it answers", async () => {
    const key = randomUUID();
    const mileage = (await vehicleMileage()) + 100;

    const response = await postMultipart(
      checklistUrl(),
      legacyChecklist(mileage, key),
      key,
    );

    expect(response.statusCode, response.body).toBe(201);

    const checklist = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: response.json().id },
    });

    expect(checklist.current_mileage).toBe(mileage);
    expect(checklist.photos).toHaveLength(3);

    const byField = checklist.photos_by_field as Record<string, string[]>;

    expect(Object.keys(byField).sort()).toEqual([
      "current_mileage",
      "fuel_level_adequate",
      "tires_condition",
    ]);

    for (const keys of Object.values(byField)) {
      expect(keys[0]).toMatch(new RegExp(`^checklistPhotos/${BUSINESS}/`));
    }
  });

  it("leaves no photo behind when the controller refuses it before the use case runs", async () => {
    const before = await storedObjects("checklistPhotos");
    const key = randomUUID();

    // Refused by the controller's schema, after the adapter stored the three
    // photos: nothing in the use case deletes them, only the adapter does.
    const response = await postMultipart(
      checklistUrl(),
      legacyChecklist((await vehicleMileage()) + 100, key, {
        tires_condition: "excellent",
      }),
      key,
    );

    expect(response.statusCode, response.body).toBe(400);
    expect(response.headers["x-error-code"]).toBe("VALIDATION_ERROR");

    await vi.waitFor(async () => {
      expect(await storedObjects("checklistPhotos")).toEqual(before);
    });
  });
});

describe("the warn line that says the adapter is still in use", () => {
  it("names the route pattern, never the raw URL (OBS-05)", async () => {
    // Whatever a client appends to the URL stays out of the logs, like on
    // every other line the application writes.
    const SECRET = "7f3c2a10-5555-4222-8333-944445555666";

    const logger = app.log as unknown as Record<symbol, unknown>;
    const original = logger[pino.symbols.streamSym];

    let written = "";

    logger[pino.symbols.streamSym] = {
      write(chunk: string) {
        written += chunk;
      },
    };

    try {
      const key = randomUUID();

      const response = await postMultipart(
        `${fuelUrl()}?token=${SECRET}`,
        legacyFuel((await vehicleMileage()) + 100, key),
        key,
      );

      expect(response.statusCode, response.body).toBe(201);
    } finally {
      logger[pino.symbols.streamSym] = original;
    }

    const deprecated = written
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (line) =>
          line.msg ===
          "Deprecated contract: multipart upload from an outdated client",
      );

    expect(deprecated).toHaveLength(1);
    expect(deprecated[0].accepted).toBe(true);
    expect(written).not.toContain(SECRET);
  });
});

describe("every other route", () => {
  it("still refuses multipart, with the sentence an outdated app can act on", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/fuel/update-fuel/${randomUUID()}/business/${BUSINESS}`,
      headers: {
        authorization: `Bearer ${seed.driverToken}`,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: legacyFuel(1_000, randomUUID()),
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().code).toBe("CLIENT_OUTDATED");
  });
});
