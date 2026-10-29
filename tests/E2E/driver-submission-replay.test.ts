import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";
import { z } from "zod";

import { createFuelSchema } from "@/schemas/create-fuel-schema";
import { createVehicleChecklistSchema } from "@/schemas/create-vehicle-checklist-schema";

import type { UploadService } from "@/shared/services/upload-service";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * What the app's outbox actually does, against a real database: send, lose
 * the answer, send the same thing again.
 *
 * Every write the driver's app queues carries a `client_submission_id` (or
 * the same value as `Idempotency-Key`), and the whole offline design rests on
 * one promise — sending it twice records it once. The unit tests prove the use
 * cases with in-memory repositories; this file proves it where it matters,
 * through the routes, the guards, the transaction and the unique index.
 *
 * It also pins the part of the promise that must survive a deploy: a resend
 * of something the server ALREADY recorded is answered with that record even
 * when the request would no longer pass today's validation. A stricter
 * schema on version N+1 must not turn a fueling that exists into a red
 * "failed" item on the driver's phone — and, worse, a retyped duplicate.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let seed: FleetDriverSeed;
let uploads: UploadService;

const BUSINESS = "018fd950-0000-7000-8000-00000000000a";

const storedKeys: string[] = [];

/** A photo already in storage, the way the presigned flow leaves it. */
async function storedPhoto(
  uploadType: "odometerPhotos" | "checklistPhotos" | "deliveryPhotos",
): Promise<string> {
  const key = `${uploadType}/${BUSINESS}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

/** The body use-fuel.ts hands to the outbox, photo key included. */
async function fuelBody(
  mileage: number,
  // null: no key in the body (the header alone carries it).
  submissionId: string | null = randomUUID(),
): Promise<Record<string, unknown>> {
  return {
    ...(submissionId && { client_submission_id: submissionId }),
    current_mileage: mileage,
    liters_amount: 50,
    price_per_liter: 6.5,
    total_amount: 325,
    refueling_date: new Date(Date.now() - 60_000).toISOString(),
    vehicleId: seed.vehicleId,
    driverId: seed.driverId,
    fuelTypeId: seed.fuelTypeId,
    branchId: seed.branchId,
    businessId: BUSINESS,
    latitude: -23.55,
    longitude: -46.63,
    created_from: "MOBILE_APP",
    photo: { key: await storedPhoto("odometerPhotos") },
  };
}

/** The body use-checklist.ts hands to the outbox, photo keys included. */
async function checklistBody(
  mileage: number,
  // null: no key in the body (the header alone carries it).
  submissionId: string | null = randomUUID(),
): Promise<Record<string, unknown>> {
  const photos = await Promise.all(
    ["current_mileage", "fuel_level_adequate", "tires_condition"].map(
      async (fieldName) => ({
        key: await storedPhoto("checklistPhotos"),
        fieldName,
      }),
    ),
  );

  return {
    ...(submissionId && { client_submission_id: submissionId }),
    vehicleId: seed.vehicleId,
    businessId: BUSINESS,
    branchId: seed.branchId,
    driverId: seed.driverId,
    checklist_date: new Date(Date.now() - 60_000).toISOString(),
    current_mileage: mileage,
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
  };
}

function post(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${seed.driverToken}`, ...headers },
    payload: body,
  });
}

const fuelUrl = () => `/fuel/create-fuel/${BUSINESS}`;
const checklistUrl = () =>
  `/vehicle-checklist/create-vehicle-checklist/${BUSINESS}`;

async function vehicleMileage(): Promise<number> {
  const vehicle = await prisma.vehicle.findUniqueOrThrow({
    where: { id: seed.vehicleId },
  });

  return vehicle.current_mileage;
}

/** What a stricter N+1 schema does to a body the N app froze in its queue. */
function stricterNextVersion() {
  return new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: ["odometer_unit"],
      message: "O campo odometer_unit é obrigatório.",
    },
  ]);
}

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "55666777000191",
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

describe("a resend that no longer passes validation (GAP5-3)", () => {
  it("is answered with the fueling it already created", async () => {
    const key = randomUUID();

    const first = await post(fuelUrl(), await fuelBody(1_100, key));
    expect(first.statusCode, first.body).toBe(201);

    const createdId = first.json().id;

    // Version N+1 now demands a field the queued body never had.
    const parse = vi.spyOn(createFuelSchema, "parse").mockImplementation(() => {
      throw stricterNextVersion();
    });

    try {
      const replay = await post(fuelUrl(), await fuelBody(1_100, key), {
        "idempotency-key": key,
      });

      expect(replay.statusCode).toBe(201);
      expect(replay.json().id).toBe(createdId);
      expect(replay.headers["idempotency-key"]).toBe(key);
    } finally {
      parse.mockRestore();
    }

    expect(
      await prisma.fuel.count({
        where: { businessId: BUSINESS, client_submission_id: key },
      }),
    ).toBe(1);
  });

  it("is answered with the checklist it already created", async () => {
    const key = randomUUID();
    const mileage = (await vehicleMileage()) + 50;

    const first = await post(checklistUrl(), await checklistBody(mileage, key));
    expect(first.statusCode, first.body).toBe(201);

    const createdId = first.json().id;

    const parse = vi
      .spyOn(createVehicleChecklistSchema, "parse")
      .mockImplementation(() => {
        throw stricterNextVersion();
      });

    try {
      const replay = await post(
        checklistUrl(),
        await checklistBody(mileage, key),
      );

      expect(replay.statusCode).toBe(201);
      expect(replay.json().id).toBe(createdId);
    } finally {
      parse.mockRestore();
    }
  });

  it("still refuses another driver's key", async () => {
    const key = randomUUID();
    const mileage = (await vehicleMileage()) + 50;

    const first = await post(fuelUrl(), await fuelBody(mileage, key));
    expect(first.statusCode, first.body).toBe(201);

    // A second driver of the same carrier, replaying a key that is not theirs.
    const { seedUser } = await import("./support/fleet-driver-seed");
    const otherDriver = await prisma.driver.create({
      data: {
        name: "Outro Motorista",
        birth_date: new Date("1990-01-01"),
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
      },
    });
    const other = await seedUser(
      prisma,
      BUSINESS,
      "BUSINESS_USER",
      otherDriver.id,
    );

    const replay = await app.inject({
      method: "POST",
      url: fuelUrl(),
      headers: { authorization: `Bearer ${other.token}` },
      payload: await fuelBody(mileage, key),
    });

    expect(replay.statusCode).toBe(409);
    expect(replay.json().code).toBe("SUBMISSION_OWNER_MISMATCH");
  });

  it("does not turn a retyped fueling into a duplicate", async () => {
    const mileage = (await vehicleMileage()) + 50;

    const first = await post(fuelUrl(), await fuelBody(mileage));
    expect(first.statusCode, first.body).toBe(201);

    // The driver gives up on the "failed" item and types it again: a new key,
    // the same odometer. The mileage rule is what keeps this from doubling.
    const retyped = await post(fuelUrl(), await fuelBody(mileage));

    expect(retyped.statusCode).toBe(400);
    expect(await vehicleMileage()).toBe(mileage);
  });
});

describe("the same submission sent twice is recorded once (TESTS-11)", () => {
  let shipperId = "";
  let occurrenceTypeId = "";

  /** A stop on the driver's route, already under way. */
  async function deliveryInTransit(): Promise<string> {
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Destinatário",
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Entregas",
        businessId: BUSINESS,
        shipperId,
        driverId: seed.driverId,
        status: "IN_TRANSIT",
      },
    });

    return delivery.id;
  }

  const deliveryUrl = (action: string, deliveryId: string) =>
    `/delivery/${action}/${deliveryId}/business/${BUSINESS}`;

  beforeAll(async () => {
    shipperId = (
      await prisma.shipper.create({
        data: { name: "Embarcador", businessId: BUSINESS },
      })
    ).id;

    occurrenceTypeId = (
      await prisma.occurrenceType.create({
        data: {
          name: "Portaria fechada",
          blocks_delivery: false,
          businessId: BUSINESS,
        },
      })
    ).id;
  });

  it("a fueling, and the odometer moves once", async () => {
    const key = randomUUID();
    const mileage = (await vehicleMileage()) + 100;
    const body = await fuelBody(mileage, key);

    const first = await post(fuelUrl(), body, { "idempotency-key": key });
    const second = await post(fuelUrl(), body, { "idempotency-key": key });

    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().id).toBe(first.json().id);

    expect(
      await prisma.fuel.count({ where: { client_submission_id: key } }),
    ).toBe(1);
    expect(await vehicleMileage()).toBe(mileage);
  });

  it("a fueling that carries its key only in the Idempotency-Key header", async () => {
    const key = randomUUID();
    const mileage = (await vehicleMileage()) + 100;
    const body = await fuelBody(mileage, null);

    const first = await post(fuelUrl(), body, { "idempotency-key": key });
    const second = await post(fuelUrl(), body, { "idempotency-key": key });

    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    expect(
      await prisma.fuel.count({ where: { client_submission_id: key } }),
    ).toBe(1);
  });

  it("a checklist, by body key and by header alone", async () => {
    for (const inBody of [true, false]) {
      const key = randomUUID();
      const mileage = (await vehicleMileage()) + 100;
      const body = await checklistBody(mileage, inBody ? key : null);

      const first = await post(checklistUrl(), body, {
        "idempotency-key": key,
      });
      const second = await post(checklistUrl(), body, {
        "idempotency-key": key,
      });

      expect(first.statusCode, first.body).toBe(201);
      expect(second.statusCode, second.body).toBe(201);
      expect(second.json().id).toBe(first.json().id);
      expect(
        await prisma.vehicleChecklist.count({
          where: { client_submission_id: key },
        }),
      ).toBe(1);
      expect(await vehicleMileage()).toBe(mileage);
    }
  });

  it("an arrival", async () => {
    const deliveryId = await deliveryInTransit();
    const key = randomUUID();
    const body = {
      client_submission_id: key,
      latitude: -23.55,
      longitude: -46.63,
    };

    const first = await post(deliveryUrl("arrival", deliveryId), body);
    const second = await post(deliveryUrl("arrival", deliveryId), body);

    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect(
      await prisma.deliveryEvent.count({
        where: { client_submission_id: key },
      }),
    ).toBe(1);
  });

  it("a proof of delivery", async () => {
    const deliveryId = await deliveryInTransit();
    const key = randomUUID();
    const body = {
      client_submission_id: key,
      received_by: "Maria Souza",
      photo: await storedPhoto("deliveryPhotos"),
    };

    const first = await post(deliveryUrl("proof", deliveryId), body);
    const second = await post(deliveryUrl("proof", deliveryId), body);

    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect(
      await prisma.deliveryEvent.count({
        where: { client_submission_id: key },
      }),
    ).toBe(1);
  });

  it("an occurrence, by body key and by header alone", async () => {
    for (const inBody of [true, false]) {
      const deliveryId = await deliveryInTransit();
      const key = randomUUID();
      const body = {
        ...(inBody && { client_submission_id: key }),
        occurrenceTypeId,
        description: "Portaria fechada",
      };

      const first = await post(
        deliveryUrl("report-occurrence", deliveryId),
        body,
        {
          "idempotency-key": key,
        },
      );
      const second = await post(
        deliveryUrl("report-occurrence", deliveryId),
        body,
        {
          "idempotency-key": key,
        },
      );

      expect(first.statusCode, first.body).toBe(201);
      expect(second.statusCode, second.body).toBe(201);
      expect(
        await prisma.deliveryOccurrence.count({ where: { deliveryId } }),
        inBody ? "body key" : "header only",
      ).toBe(1);
    }
  });
});
