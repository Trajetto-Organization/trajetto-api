import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { env } from "@/env";
import type { UploadService } from "@/shared/services/upload-service";
import { ensureDefaultOccurrenceTypes } from "@/shared/delivery/default-occurrence-types";
import { getOrCreateCurrentPeriod } from "@/shared/ai/ai-quota-service";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The phone's offline pre-check travelling with the submission (decision
 * 14.2; design ia-local-implementacao §P5), through the real routes and a
 * real database:
 *
 * - kept on the proof's audit card, the fueling and the checklist, once —
 *   a resend with the same key never rewrites it;
 * - only for a company that bought the reading and a server that reads;
 *   otherwise accepted and dropped, never refused (a 400 parks the queue);
 * - a malformed or other-kind pre-check is dropped, the submission goes in;
 * - it never spends a unit: one photo is one unit, counted once;
 * - /user/me says whether the app runs it;
 * - tenant and role guards of the routes it rides on.
 */
const prisma = createPrismaClient();

const CARRIER = "018fe2a0-0000-7000-8000-00000000000a";
const NO_AI = "018fe2a0-0000-7000-8000-00000000000b";
const SPENT = "018fe2a0-0000-7000-8000-00000000000c";

let app: Awaited<typeof import("@/http")>["app"];
let carrier: FleetDriverSeed;
let noAi: FleetDriverSeed;
let spent: FleetDriverSeed;
let uploads: UploadService;
const shippers = new Map<string, string>();

const storedKeys: string[] = [];

const saved = {
  url: env.AI_LOCAL_URL,
  token: env.AI_LOCAL_TOKEN,
  provider: env.AI_PROVIDER,
  workers: env.WORKERS_ENABLED,
};

/**
 * The server reading on (a URL nobody answers). The pipeline must also never
 * run here: on a worker-enabled replica the report's commit wakes a cycle that
 * claims the queued reading (PROCESSING) and races every assertion about the
 * queued state, so this file runs as an HTTP-only replica.
 */
function readerOn(on: boolean) {
  env.AI_PROVIDER = "local";
  env.AI_LOCAL_URL = on ? "http://127.0.0.1:9" : undefined;
  env.AI_LOCAL_TOKEN = on ? "t".repeat(40) : undefined;
}

function precheck(overrides: Record<string, unknown> = {}) {
  return {
    engine: "mlkit-text-v2-latin",
    engine_version: "16.0.1",
    rules_version: 1,
    ran_at: new Date(Date.now() - 60_000).toISOString(),
    duration_ms: 420,
    kind: "proof",
    invoice_number_found: true,
    date_out_of_window: false,
    typed_mileage_found: null,
    outcome: "ok",
    driver_overrode: false,
    ...overrides,
  };
}

const odometerPrecheck = (overrides: Record<string, unknown> = {}) =>
  precheck({
    kind: "odometer",
    invoice_number_found: null,
    date_out_of_window: null,
    typed_mileage_found: true,
    ...overrides,
  });

async function storedPhoto(
  businessId: string,
  folder:
    | "deliveryPhotos"
    | "odometerPhotos"
    | "checklistPhotos" = "deliveryPhotos",
): Promise<string> {
  const key = `${folder}/${businessId}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

async function deliveryInTransit(seed: FleetDriverSeed): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: "Mercado Central",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      invoice_number: "123456",
      businessId: seed.businessId,
      shipperId: shippers.get(seed.businessId)!,
      driverId: seed.driverId,
      status: "IN_TRANSIT",
    },
  });

  return delivery.id;
}

async function deliveredTypeId(businessId: string): Promise<string> {
  return (
    await prisma.occurrenceType.findUniqueOrThrow({
      where: {
        businessId_system_key: { businessId, system_key: "delivered_default" },
      },
    })
  ).id;
}

async function deliveredBody(
  seed: FleetDriverSeed,
  extra: Record<string, unknown> = {},
) {
  return {
    occurrenceTypeId: await deliveredTypeId(seed.businessId),
    client_submission_id: randomUUID(),
    receipt_photo: await storedPhoto(seed.businessId),
    ...extra,
  };
}

const report = (
  deliveryId: string,
  token: string,
  body: Record<string, unknown>,
  businessId: string,
) =>
  app.inject({
    method: "POST",
    url: `/delivery/report-occurrence/${deliveryId}/business/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

async function cardOf(deliveryId: string) {
  return prisma.deliveryProofAudit.findUnique({ where: { deliveryId } });
}

/** Units the period holds for the company: reserved + consumed. */
async function unitsSpent(businessId: string): Promise<number> {
  const rows = await prisma.aIUsagePeriod.findMany({ where: { businessId } });

  return rows.reduce(
    (sum, row) => sum + row.reservedUnits + row.consumedUnits,
    0,
  );
}

function fuelBody(
  seed: FleetDriverSeed,
  mileage: number,
  extra: Record<string, unknown> = {},
) {
  return storedPhoto(seed.businessId, "odometerPhotos").then((key) => ({
    client_submission_id: randomUUID(),
    current_mileage: mileage,
    liters_amount: 50,
    price_per_liter: 6.5,
    total_amount: 325,
    refueling_date: new Date(Date.now() - 60_000).toISOString(),
    vehicleId: seed.vehicleId,
    driverId: seed.driverId,
    fuelTypeId: seed.fuelTypeId,
    branchId: seed.branchId,
    businessId: seed.businessId,
    latitude: -23.55,
    longitude: -46.63,
    created_from: "MOBILE_APP",
    photo: { key },
    ...extra,
  }));
}

async function checklistBody(
  seed: FleetDriverSeed,
  mileage: number,
  extra: Record<string, unknown> = {},
) {
  const photos = await Promise.all(
    ["current_mileage", "fuel_level_adequate", "tires_condition"].map(
      async (fieldName) => ({
        key: await storedPhoto(seed.businessId, "checklistPhotos"),
        fieldName,
      }),
    ),
  );

  return {
    client_submission_id: randomUUID(),
    vehicleId: seed.vehicleId,
    businessId: seed.businessId,
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
    ...extra,
  };
}

const post = (url: string, token: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

async function vehicleMileage(seed: FleetDriverSeed): Promise<number> {
  return (
    await prisma.vehicle.findUniqueOrThrow({ where: { id: seed.vehicleId } })
  ).current_mileage;
}

const me = (token: string) =>
  app.inject({
    method: "GET",
    url: "/user/me",
    headers: { authorization: `Bearer ${token}` },
  });

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55666990000191",
    mileage: 1_000,
  });
  noAi = await seedFleetDriver(prisma, {
    businessId: NO_AI,
    cnpj: "55666990000272",
    mileage: 1_000,
  });
  spent = await seedFleetDriver(prisma, {
    businessId: SPENT,
    cnpj: "55666990000353",
    mileage: 1_000,
  });

  await prisma.business.update({
    where: { id: CARRIER },
    data: { ai_analysis_limit: 100 },
  });
  await prisma.business.update({
    where: { id: NO_AI },
    data: { ai_analysis_limit: 0 },
  });
  await prisma.business.update({
    where: { id: SPENT },
    data: { ai_analysis_limit: 1 },
  });

  for (const businessId of [CARRIER, NO_AI, SPENT]) {
    await ensureDefaultOccurrenceTypes(prisma, businessId);
    shippers.set(
      businessId,
      (
        await prisma.shipper.create({
          data: { name: "Embarcador", businessId },
        })
      ).id,
    );
  }

  // SPENT used its only unit this month.
  const period = await getOrCreateCurrentPeriod(prisma, SPENT);
  await prisma.aIUsagePeriod.update({
    where: { id: period.id },
    data: { consumedUnits: 1 },
  });

  readerOn(true);
  env.WORKERS_ENABLED = false;

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");
}, 120_000);

afterAll(async () => {
  env.AI_LOCAL_URL = saved.url;
  env.AI_LOCAL_TOKEN = saved.token;
  env.AI_PROVIDER = saved.provider;
  env.WORKERS_ENABLED = saved.workers;

  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the receipt pre-check on a delivered report", () => {
  it("is kept on the audit card once, and a resend neither rewrites it nor spends a unit", async () => {
    const deliveryId = await deliveryInTransit(carrier);
    const before = await unitsSpent(CARRIER);

    const sentPrecheck = precheck();
    const body = await deliveredBody(carrier, {
      device_precheck: sentPrecheck,
    });
    const first = await report(deliveryId, carrier.driverToken, body, CARRIER);

    expect(first.statusCode, first.body).toBe(201);
    expect((await cardOf(deliveryId))?.device_precheck).toEqual(sentPrecheck);

    // The outbox resends after a dead network, now with what a later build
    // would have said: the first write stands.
    const resend = await report(
      deliveryId,
      carrier.driverToken,
      {
        ...body,
        device_precheck: precheck({
          ran_at: sentPrecheck.ran_at,
          invoice_number_found: false,
          outcome: "warned",
          driver_overrode: true,
        }),
      },
      CARRIER,
    );

    expect(resend.statusCode, resend.body).toBe(201);
    expect(resend.json().data.replayed).toBe(true);

    const card = await cardOf(deliveryId);

    expect(card?.device_precheck).toMatchObject({
      invoice_number_found: true,
      outcome: "ok",
    });
    expect(card?.device_agreement).toBeNull();

    // One photo, one unit — the pre-check reserved nothing of its own.
    expect(await unitsSpent(CARRIER)).toBe(before + 1);
    expect(
      await prisma.aIAnalysisRequest.count({
        where: {
          businessId: CARRIER,
          recordId: deliveryId,
          type: "DELIVERY_PROOF",
        },
      }),
    ).toBe(1);
  });

  it("drops a malformed pre-check and still records the delivery", async () => {
    const deliveryId = await deliveryInTransit(carrier);

    const response = await report(
      deliveryId,
      carrier.driverToken,
      await deliveredBody(carrier, {
        device_precheck: { engine: "tesseract", text: "MARIA DA SILVA 123456" },
      }),
      CARRIER,
    );

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data.delivery_status).toBe("DELIVERED");
    expect((await cardOf(deliveryId))?.device_precheck).toBeNull();
  });

  it("drops an odometer pre-check sent with a receipt", async () => {
    const deliveryId = await deliveryInTransit(carrier);

    const response = await report(
      deliveryId,
      carrier.driverToken,
      await deliveredBody(carrier, { device_precheck: odometerPrecheck() }),
      CARRIER,
    );

    expect(response.statusCode, response.body).toBe(201);
    expect((await cardOf(deliveryId))?.device_precheck).toBeNull();
  });

  it("is not kept for a company that did not buy the reading", async () => {
    const deliveryId = await deliveryInTransit(noAi);
    const before = await unitsSpent(NO_AI);

    const response = await report(
      deliveryId,
      noAi.driverToken,
      await deliveredBody(noAi, { device_precheck: precheck() }),
      NO_AI,
    );

    expect(response.statusCode, response.body).toBe(201);
    expect((await cardOf(deliveryId))?.device_precheck).toBeNull();
    expect(await unitsSpent(NO_AI)).toBe(before);
  });

  it("is not kept while the server reading is off", async () => {
    const deliveryId = await deliveryInTransit(carrier);

    readerOn(false);

    try {
      const response = await report(
        deliveryId,
        carrier.driverToken,
        await deliveredBody(carrier, { device_precheck: precheck() }),
        CARRIER,
      );

      expect(response.statusCode, response.body).toBe(201);
    } finally {
      readerOn(true);
    }

    expect((await cardOf(deliveryId))?.device_precheck).toBeNull();
  });

  it("rides the installed app's proof route too", async () => {
    const deliveryId = await deliveryInTransit(carrier);

    const response = await post(
      `/delivery/proof/${deliveryId}/business/${CARRIER}`,
      carrier.driverToken,
      {
        client_submission_id: randomUUID(),
        photo: await storedPhoto(CARRIER),
        device_precheck: precheck({
          invoice_number_found: false,
          outcome: "warned",
          driver_overrode: true,
        }),
      },
    );

    expect(response.statusCode, response.body).toBe(201);
    expect((await cardOf(deliveryId))?.device_precheck).toMatchObject({
      invoice_number_found: false,
      driver_overrode: true,
    });
  });

  it("writes nothing for another company's driver (404) or for the office (403)", async () => {
    const deliveryId = await deliveryInTransit(carrier);

    const foreign = await report(
      deliveryId,
      noAi.driverToken,
      await deliveredBody(carrier, { device_precheck: precheck() }),
      CARRIER,
    );

    expect(`${foreign.statusCode} ${foreign.json().code}`).toBe(
      "403 TENANT_ACCESS_DENIED",
    );

    const office = await report(
      deliveryId,
      carrier.managerToken,
      await deliveredBody(carrier, { device_precheck: precheck() }),
      CARRIER,
    );

    expect(`${office.statusCode} ${office.json().code}`).toBe(
      "403 DRIVER_ONLY",
    );
    expect(await cardOf(deliveryId)).toBeNull();
  });
});

describe("the audit queue", () => {
  it("shows the pre-check next to the server's reading, to its own company only", async () => {
    const deliveryId = await deliveryInTransit(carrier);

    const sent = await report(
      deliveryId,
      carrier.driverToken,
      await deliveredBody(carrier, {
        device_precheck: precheck({
          date_out_of_window: true,
          outcome: "warned",
          driver_overrode: true,
        }),
      }),
      CARRIER,
    );
    expect(sent.statusCode, sent.body).toBe(201);

    const listing = await app.inject({
      method: "GET",
      url: `/delivery/proof-audits?status=PENDING&page=1&pageSize=100`,
      headers: { authorization: `Bearer ${carrier.managerToken}` },
    });

    expect(listing.statusCode, listing.body).toBe(200);

    const cards = listing.body
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line));
    const card = cards.find((entry) => entry.deliveryId === deliveryId);

    expect(card.device_precheck).toMatchObject({
      kind: "proof",
      date_out_of_window: true,
      driver_overrode: true,
    });
    // No server reading yet: nothing to compare, and the card says the
    // phone's hint is provisional while the reading is queued.
    expect(card.deviceAgreement).toBeNull();
    expect(card.analysisStatus).toBe("PENDING");
    expect(card.aiState).toBe("device_provisional");

    // Still untouched a moment later: nothing on this replica claimed it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const queued = await prisma.aIAnalysisRequest.findFirstOrThrow({
      where: { recordId: deliveryId },
    });
    expect({ status: queued.status, attempts: queued.attempts }).toEqual({
      status: "PENDING",
      attempts: 0,
    });

    const otherCompany = await app.inject({
      method: "GET",
      url: `/delivery/proof-audits?status=PENDING&page=1&pageSize=100`,
      headers: { authorization: `Bearer ${noAi.managerToken}` },
    });

    expect(otherCompany.body).not.toContain(deliveryId);

    const driver = await app.inject({
      method: "GET",
      url: `/delivery/proof-audits?status=PENDING&page=1&pageSize=100`,
      headers: { authorization: `Bearer ${carrier.driverToken}` },
    });

    expect(driver.statusCode).toBe(403);
  });
});

describe("the odometer pre-check", () => {
  it("is kept on the fueling once, and a resend does not rewrite it", async () => {
    const body = await fuelBody(
      carrier,
      (await vehicleMileage(carrier)) + 100,
      {
        device_precheck: odometerPrecheck(),
      },
    );

    const first = await post(
      `/fuel/create-fuel/${CARRIER}`,
      carrier.driverToken,
      body,
    );
    expect(first.statusCode, first.body).toBe(201);

    const resend = await post(
      `/fuel/create-fuel/${CARRIER}`,
      carrier.driverToken,
      {
        ...body,
        device_precheck: odometerPrecheck({
          typed_mileage_found: false,
          outcome: "warned",
        }),
      },
    );
    expect(resend.statusCode, resend.body).toBe(201);
    expect(resend.json().id).toBe(first.json().id);

    const fuel = await prisma.fuel.findUniqueOrThrow({
      where: { id: first.json().id },
    });

    expect(fuel.odometer_device_precheck).toMatchObject({
      kind: "odometer",
      typed_mileage_found: true,
    });
    expect(fuel.odometer_device_agreement).toBeNull();
  });

  it("drops a receipt pre-check on a fueling, and any pre-check of a company without the reading", async () => {
    const wrongKind = await post(
      `/fuel/create-fuel/${CARRIER}`,
      carrier.driverToken,
      await fuelBody(carrier, (await vehicleMileage(carrier)) + 100, {
        device_precheck: precheck(),
      }),
    );
    expect(wrongKind.statusCode, wrongKind.body).toBe(201);
    expect(
      (
        await prisma.fuel.findUniqueOrThrow({
          where: { id: wrongKind.json().id },
        })
      ).odometer_device_precheck,
    ).toBeNull();

    const notBought = await post(
      `/fuel/create-fuel/${NO_AI}`,
      noAi.driverToken,
      await fuelBody(noAi, (await vehicleMileage(noAi)) + 100, {
        device_precheck: odometerPrecheck(),
      }),
    );
    expect(notBought.statusCode, notBought.body).toBe(201);
    expect(
      (
        await prisma.fuel.findUniqueOrThrow({
          where: { id: notBought.json().id },
        })
      ).odometer_device_precheck,
    ).toBeNull();
  });

  it("is kept on the checklist with the odometer photo, once", async () => {
    const body = await checklistBody(
      carrier,
      (await vehicleMileage(carrier)) + 50,
      {
        device_precheck: odometerPrecheck(),
      },
    );

    const first = await post(
      `/vehicle-checklist/create-vehicle-checklist/${CARRIER}`,
      carrier.driverToken,
      body,
    );
    expect(first.statusCode, first.body).toBe(201);

    const resend = await post(
      `/vehicle-checklist/create-vehicle-checklist/${CARRIER}`,
      carrier.driverToken,
      {
        ...body,
        device_precheck: odometerPrecheck({ typed_mileage_found: null }),
      },
    );
    expect(resend.statusCode, resend.body).toBe(201);
    expect(resend.json().id).toBe(first.json().id);

    const checklist = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: first.json().id },
    });

    expect(checklist.mileage_device_precheck).toMatchObject({
      typed_mileage_found: true,
    });

    // The AI request's input is hashed for idempotency: the pre-check must
    // not be in it, or the same photo would be a different request.
    const request = await prisma.aIAnalysisRequest.findFirst({
      where: {
        businessId: CARRIER,
        recordId: first.json().id,
        type: "CHECKLIST",
      },
    });

    expect(JSON.stringify(request?.input ?? {})).not.toContain(
      "device_precheck",
    );
  });

  it("refuses another company's fueling as before, writing nothing", async () => {
    const response = await post(
      `/fuel/create-fuel/${CARRIER}`,
      noAi.driverToken,
      await fuelBody(carrier, (await vehicleMileage(carrier)) + 100, {
        device_precheck: odometerPrecheck(),
      }),
    );

    expect(response.statusCode).toBe(403);
  });
});

describe("the session flag (/user/me)", () => {
  it("turns the pre-check on only with the reading bought, on, and with quota left", async () => {
    expect((await me(carrier.driverToken)).json().user.ai).toEqual({
      precheck: true,
      reason: null,
    });
    expect((await me(noAi.driverToken)).json().user.ai).toEqual({
      precheck: false,
      reason: "not_contracted",
    });
    expect((await me(spent.driverToken)).json().user.ai).toEqual({
      precheck: false,
      reason: "quota_exhausted",
    });

    readerOn(false);

    try {
      expect((await me(carrier.driverToken)).json().user.ai).toEqual({
        precheck: false,
        reason: "unavailable",
      });
    } finally {
      readerOn(true);
    }
  });
});
