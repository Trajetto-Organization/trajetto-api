import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { businessDateKey, businessDayStart } from "@/shared/time/business-day";

import { seedFleetDriver, type FleetDriverSeed } from "./support/fleet-driver-seed";

/**
 * Editing a checklist that already happened, over real HTTP (FLEET-FUEL-1,
 * the checklist half; decision 1.2).
 *
 * - The web form resent every link unchanged, and the route's branch gate and
 *   the use case held each one to TODAY's state: last month's checklist of a
 *   driver who left, or at a branch since closed, could not get a note fixed.
 *   Now only a link the edit changes is checked.
 * - A km typo on an older checklist could never be corrected: the new reading
 *   had to pass the vehicle's odometer as it is now. It may now sit between
 *   the records around the checklist's date, itself left out, and then the
 *   vehicle keeps its mileage.
 * - The edit accepted a date in the future; the date-only form gave a 500,
 *   and once stored, a date-only TOMORROW passed as today.
 * - Moving a checklist to another date was not checked against the readings
 *   around the new date, and raising an older checklist above the odometer
 *   jumped the odometer past the checklists after it.
 * - Another company's vehicle, driver, branch or checklist was answered with
 *   "não pertence a esta empresa", confirming the id exists elsewhere.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe310-0000-7000-8000-00000000000a";
const OTHER = "018fe310-0000-7000-8000-00000000000b";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let seed: FleetDriverSeed;
let otherSeed: FleetDriverSeed;

let closedBranchId = "";
let formerDriverId = "";
let masterToken = "";
let readOnlyToken = "";

async function seedToken(
  role: "MASTER" | "BUSINESS_USER",
  businessId: string | null,
  profileAccessId?: string,
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: `Usuário ${id.slice(0, 4)}`,
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      profileAccessId: profileAccessId ?? null,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + HOUR),
    },
  });

  return sign({ tokenType: "access", sessionVersion: 0, familyId }, auth.secret_token, {
    subject: id,
    expiresIn: "30m",
  });
}

const PHOTO_FIELDS = ["current_mileage", "fuel_level_adequate", "tires_condition"];

/** A checklist row as the app leaves it, with the photos the edit requires. */
async function seedChecklist(input: {
  mileage: number;
  at: Date;
  branchId?: string;
  driverId?: string;
  vehicleId?: string;
}): Promise<string> {
  const checklist = await prisma.vehicleChecklist.create({
    data: {
      current_mileage: input.mileage,
      checklist_date: input.at,
      tires_condition: "good",
      bumpers_condition: "good",
      windshield_condition: "good",
      mirrors_condition: "good",
      steering_wheel_condition: "good",
      battery_condition: "good",
      spare_tire_condition: "good",
      fuel_level_adequate: true,
      overall_condition: "approved",
      photos: PHOTO_FIELDS.map(
        (field) => `checklistPhotos/${CARRIER}/${randomUUID()}-${field}.jpg`,
      ),
      businessId: CARRIER,
      branchId: input.branchId ?? seed.branchId,
      driverId: input.driverId ?? seed.driverId,
      vehicleId: input.vehicleId ?? seed.vehicleId,
    },
  });

  return checklist.id;
}

function patch(
  checklistId: string,
  body: Record<string, unknown>,
  token = seed.managerToken,
  businessId = CARRIER,
) {
  return app.inject({
    method: "PATCH",
    url: `/vehicle-checklist/update-vehicle-checklist/${checklistId}/business/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

/** The company's tomorrow as "YYYY-MM-DD" (the seed keeps the default zone). */
function companyTomorrow(): string {
  return businessDateKey(new Date(Date.now() + DAY), "America/Sao_Paulo");
}

/** Keys for the photos the create always requires; never read before the refusals below. */
const REQUIRED_PHOTOS = PHOTO_FIELDS.map((fieldName) => ({
  key: `checklistPhotos/${CARRIER}/${randomUUID()}-${fieldName}.jpg`,
  fieldName,
}));

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vehicleId: seed.vehicleId,
    businessId: CARRIER,
    branchId: seed.branchId,
    driverId: seed.driverId,
    checklist_date: new Date(Date.now() - HOUR).toISOString(),
    current_mileage: 30_000,
    overall_condition: "approved",
    tires_condition: "good",
    bumpers_condition: "good",
    windshield_condition: "good",
    mirrors_condition: "good",
    steering_wheel_condition: "good",
    battery_condition: "good",
    spare_tire_condition: "good",
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
    photos: REQUIRED_PHOTOS,
    ...overrides,
  };
}

function create(body: Record<string, unknown>, token = seed.managerToken) {
  return app.inject({
    method: "POST",
    url: `/vehicle-checklist/create-vehicle-checklist/${CARRIER}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

async function vehicleMileage(vehicleId = seed.vehicleId): Promise<number> {
  return (await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).current_mileage;
}

/** Another truck of the carrier, with its own odometer and history. */
async function seedVehicle(mileage: number): Promise<string> {
  const base = await prisma.vehicle.findUniqueOrThrow({ where: { id: seed.vehicleId } });

  const truck = await prisma.vehicle.create({
    data: {
      license_plate: randomUUID().slice(0, 7).toUpperCase(),
      description: "Outro caminhão",
      brand: base.brand,
      model: base.model,
      acquisition_date: base.acquisition_date,
      fleet_type: base.fleet_type,
      current_mileage: mileage,
      maintenance_interval_km: base.maintenance_interval_km,
      maintenance_interval_months: base.maintenance_interval_months,
      renavam: randomUUID().slice(0, 11),
      manufacturing_year: base.manufacturing_year,
      model_year: base.model_year,
      km_per_liter: base.km_per_liter,
      number_of_axles: base.number_of_axles,
      status: "ACTIVE",
      businessId: CARRIER,
      branchId: seed.branchId,
      vehicleTypeId: base.vehicleTypeId,
      fuelTypeId: base.fuelTypeId,
    },
  });

  return truck.id;
}

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "55666777000515",
    mileage: 20_000,
  });

  otherSeed = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "55666777000696",
  });

  const closed = await prisma.branch.create({
    data: {
      corporate_reason: "Filial fechada",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "55666777000777",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `fechada-${randomUUID()}@exemplo.com.br`,
      is_active: false,
      businessId: CARRIER,
    },
  });

  closedBranchId = closed.id;

  const former = await prisma.driver.create({
    data: {
      name: "Motorista que saiu",
      birth_date: new Date("1985-01-01"),
      cnh: randomUUID().replace(/-/g, "").slice(0, 11),
      cpf: randomUUID().slice(0, 14),
      rg: randomUUID().slice(0, 12),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "INACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  formerDriverId = former.id;

  masterToken = await seedToken("MASTER", null);

  const readOnly = await prisma.profileAccess.create({
    data: {
      name: "Checklist somente leitura",
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "vehicle_checklist_manage",
            action: "vehicle_checklist_manage",
            canRead: true,
            canWrite: false,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  readOnlyToken = await seedToken("BUSINESS_USER", CARRIER, readOnly.id);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("PATCH update-vehicle-checklist — a past checklist keeps its links", () => {
  it("fixes a note on the checklist of a driver who left, at a closed branch, with the links resent", async () => {
    const past = await seedChecklist({
      mileage: 15_000,
      at: new Date(Date.now() - 30 * DAY),
      branchId: closedBranchId,
      driverId: formerDriverId,
    });

    const response = await patch(past, {
      notes: "Retrovisor trocado depois",
      branchId: closedBranchId,
      driverId: formerDriverId,
      vehicleId: seed.vehicleId,
    });

    expect(response.statusCode).toBe(200);

    const stored = await prisma.vehicleChecklist.findUniqueOrThrow({ where: { id: past } });

    expect(stored.notes).toBe("Retrovisor trocado depois");
    expect(stored.driverId).toBe(formerDriverId);
    expect(stored.branchId).toBe(closedBranchId);
  });

  it("still refuses moving a checklist to an inactive driver or a closed branch", async () => {
    const current = await seedChecklist({ mileage: 16_000, at: new Date(Date.now() - 20 * DAY) });

    const toFormer = await patch(current, { driverId: formerDriverId });

    expect(toFormer.statusCode).toBe(422);
    expect(toFormer.body).toContain("DRIVER_INACTIVE");

    const toClosed = await patch(current, { branchId: closedBranchId });

    expect(toClosed.statusCode).toBe(409);
    expect(toClosed.body).toContain("BRANCH_INACTIVE");

    const stored = await prisma.vehicleChecklist.findUniqueOrThrow({ where: { id: current } });

    expect(stored.driverId).toBe(seed.driverId);
    expect(stored.branchId).toBe(seed.branchId);
  });

  it("refuses links of another company exactly like ids that exist nowhere", async () => {
    const current = await seedChecklist({ mileage: 16_500, at: new Date(Date.now() - 19 * DAY) });

    // Red before: "Este motorista/veículo/filial não pertence a esta empresa!"
    // for the foreign id, "não encontrado" for the random one, and no code.
    const cases: Array<[string, string, string]> = [
      ["vehicleId", otherSeed.vehicleId, "VEHICLE_NOT_FOUND"],
      ["driverId", otherSeed.driverId, "DRIVER_NOT_FOUND"],
      ["branchId", otherSeed.branchId, "BRANCH_NOT_FOUND"],
    ];

    for (const [field, foreignId, code] of cases) {
      const foreign = await patch(current, { [field]: foreignId });
      const unknown = await patch(current, { [field]: randomUUID() });

      expect(foreign.statusCode, field).toBe(400);
      expect(foreign.json(), field).toEqual(unknown.json());
      expect(foreign.json().code, field).toBe(code);
      expect(foreign.headers["x-error-code"], field).toBe(code);
    }

    const stored = await prisma.vehicleChecklist.findUniqueOrThrow({ where: { id: current } });

    expect(stored.driverId).toBe(seed.driverId);
    expect(stored.vehicleId).toBe(seed.vehicleId);
    expect(stored.branchId).toBe(seed.branchId);
  });
});

describe("PATCH update-vehicle-checklist — correcting an older checklist's km", () => {
  // The vehicle's history for these cases (the vehicle reads 20 000 now):
  //   12 days ago  17 000
  //   10 days ago  17 900   ← the typo: the odometer really said 17 500
  //    8 days ago  18 200
  let typo = "";

  beforeAll(async () => {
    await seedChecklist({ mileage: 17_000, at: new Date(Date.now() - 12 * DAY) });
    typo = await seedChecklist({ mileage: 17_900, at: new Date(Date.now() - 10 * DAY) });
    await seedChecklist({ mileage: 18_200, at: new Date(Date.now() - 8 * DAY) });
  });

  it("accepts a reading between its neighbours and leaves the vehicle's odometer alone", async () => {
    const response = await patch(typo, { current_mileage: 17_500 });

    expect(response.statusCode).toBe(200);

    const stored = await prisma.vehicleChecklist.findUniqueOrThrow({ where: { id: typo } });

    expect(stored.current_mileage).toBe(17_500);
    expect(await vehicleMileage()).toBe(20_000);
  });

  it("does not count the checklist being edited as its own neighbour", async () => {
    // 17 100 is below the checklist's previous value (17 500 after the case
    // above): with itself as the "record before", this was refused.
    const response = await patch(typo, { current_mileage: 17_100 });

    expect(response.statusCode).toBe(200);
  });

  it("refuses a reading outside the records around its date", async () => {
    const belowBefore = await patch(typo, { current_mileage: 16_900 });

    expect(belowBefore.statusCode).toBe(400);

    const aboveAfter = await patch(typo, { current_mileage: 18_300 });

    expect(aboveAfter.statusCode).toBe(400);

    const stored = await prisma.vehicleChecklist.findUniqueOrThrow({ where: { id: typo } });

    expect(stored.current_mileage).toBe(17_100);
  });

  it("refuses raising it above the odometer, past the checklist after it", async () => {
    // Red before: "ahead of the odometer" was tried first, so this answered
    // 200 and the vehicle jumped to 25 000 with the 18 200 of 8 days ago
    // after it. Correcting it back left the odometer at 25 000, and every
    // app record at the real km was refused until a MASTER fixed the vehicle.
    const response = await patch(typo, { current_mileage: 25_000 });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("VEHICLE_MILEAGE_OUT_OF_ORDER");
    expect(response.headers["x-error-code"]).toBe("VEHICLE_MILEAGE_OUT_OF_ORDER");
    expect(response.json().message).toContain("entre 17.000 km e 18.200 km");

    const stored = await prisma.vehicleChecklist.findUniqueOrThrow({ where: { id: typo } });

    expect(stored.current_mileage).toBe(17_100);
    expect(await vehicleMileage()).toBe(20_000);
  });

  it("moves the odometer when the newest reading passes it, and back down on its correction", async () => {
    const newest = await seedChecklist({ mileage: 19_000, at: new Date(Date.now() - 2 * DAY) });

    const response = await patch(newest, { current_mileage: 20_500 });

    expect(response.statusCode).toBe(200);
    expect(await vehicleMileage()).toBe(20_500);

    // Red before: the newest could never go down (nothing after it to fit
    // under), so a typo there froze the odometer. It set the odometer, so
    // the odometer follows the correction.
    const corrected = await patch(newest, { current_mileage: 20_100 });

    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(await vehicleMileage()).toBe(20_100);

    // Still above the readings before it.
    const belowBefore = await patch(newest, { current_mileage: 18_100 });

    expect(belowBefore.statusCode).toBe(400);
    expect(belowBefore.json().code).toBe("VEHICLE_MILEAGE_OUT_OF_ORDER");
    expect(await vehicleMileage()).toBe(20_100);
  });
});

describe("PATCH update-vehicle-checklist — the date", () => {
  it("refuses a date after the company's today", async () => {
    const current = await seedChecklist({ mileage: 16_700, at: new Date(Date.now() - 5 * DAY) });

    // A day and a half ahead is tomorrow in every Brazilian zone.
    const response = await patch(current, {
      checklist_date: new Date(Date.now() + 36 * HOUR).toISOString(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("CHECKLIST_DATE_IN_FUTURE");
  });

  it("refuses a date-only tomorrow, which read as an instant was still today", async () => {
    const current = await seedChecklist({ mileage: 16_750, at: new Date(Date.now() - 5 * DAY) });

    // Red before: 00:00 UTC of tomorrow is this evening in São Paulo, so the
    // check passed, and every screen then showed tomorrow.
    const response = await patch(current, { checklist_date: companyTomorrow() });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("CHECKLIST_DATE_IN_FUTURE");

    const stored = await prisma.vehicleChecklist.findUniqueOrThrow({ where: { id: current } });

    expect(stored.checklist_date.getTime()).toBeLessThan(Date.now());
  });

  it("lets a row already dated ahead get a note fixed, its date resent", async () => {
    // A date-only tomorrow the old rule let through. Red before: every edit
    // that resent the stored date (the web always does) was refused with
    // CHECKLIST_DATE_IN_FUTURE, though the date did not move.
    const storedDate = `${companyTomorrow()}T00:00:00.000Z`;
    const ahead = await seedChecklist({ mileage: 16_800, at: new Date(storedDate) });

    try {
      const response = await patch(ahead, { notes: "Pneu trocado", checklist_date: storedDate });

      expect(response.statusCode, response.body).toBe(200);

      const stored = await prisma.vehicleChecklist.findUniqueOrThrow({ where: { id: ahead } });

      expect(stored.notes).toBe("Pneu trocado");

      // Moving it is still held to today.
      const moved = await patch(ahead, {
        checklist_date: new Date(Date.now() + 36 * HOUR).toISOString(),
      });

      expect(moved.statusCode).toBe(400);
      expect(moved.json().code).toBe("CHECKLIST_DATE_IN_FUTURE");
    } finally {
      // Dated ahead of everything, it would bound the date moves below.
      await prisma.vehicleChecklist.delete({ where: { id: ahead } });
    }
  });

  it("stores a date-only value as that day instead of failing with a 500", async () => {
    // A reading that stays in order at the new date: between the 18 200 of
    // 8 days ago and the 20 100 of 2 days ago (the date move is checked).
    const current = await seedChecklist({ mileage: 20_000, at: new Date(Date.now() - 5 * DAY) });

    const day = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10);
    const response = await patch(current, { checklist_date: day });

    expect(response.statusCode, response.body).toBe(200);

    const stored = await prisma.vehicleChecklist.findUniqueOrThrow({ where: { id: current } });

    // The day starts in the company's zone (decision 15.1), not at 00:00 UTC
    // — the evening before in Brazil.
    expect(stored.checklist_date.toISOString()).toBe(
      businessDayStart(day, "America/Sao_Paulo").toISOString(),
    );
  });
});

describe("PATCH update-vehicle-checklist — who may edit", () => {
  it("refuses another company's manager, a read-only profile and the driver; 404 for a missing id", async () => {
    const current = await seedChecklist({ mileage: 16_900, at: new Date(Date.now() - 4 * DAY) });

    const otherManager = await patch(current, { notes: "x" }, otherSeed.managerToken);

    expect(otherManager.statusCode).toBe(403);

    const readOnly = await patch(current, { notes: "x" }, readOnlyToken);

    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.body).toContain("PERMISSION_DENIED");

    // The driver's write grant is for sending checklists from the app; the
    // edit is refused as a permission (decision 4.1), before it was a 400.
    const driver = await patch(current, { notes: "x" }, seed.driverToken);

    expect(driver.statusCode).toBe(403);
    expect(driver.body).toContain("PERMISSION_DENIED");

    const missing = await patch(randomUUID(), { notes: "x" });

    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("VEHICLE_CHECKLIST_NOT_FOUND");

    const stored = await prisma.vehicleChecklist.findUniqueOrThrow({ where: { id: current } });

    expect(stored.notes).toBeNull();
  });

  it("lets the MASTER edit a company's checklist it names", async () => {
    const current = await seedChecklist({ mileage: 16_950, at: new Date(Date.now() - 4 * DAY) });

    const response = await patch(current, { notes: "Revisado pela plataforma" }, masterToken);

    expect(response.statusCode).toBe(200);
  });
});

describe("DELETE delete-vehicle-checklist", () => {
  const remove = (checklistId: string, token = seed.managerToken, businessId = CARRIER) =>
    app.inject({
      method: "DELETE",
      url: `/vehicle-checklist/delete-vehicle-checklist/${checklistId}/business/${businessId}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it("answers another company's checklist like a missing one, and leaves it", async () => {
    const foreign = await prisma.vehicleChecklist.create({
      data: {
        current_mileage: 5_000,
        tires_condition: "good",
        bumpers_condition: "good",
        windshield_condition: "good",
        mirrors_condition: "good",
        steering_wheel_condition: "good",
        battery_condition: "good",
        spare_tire_condition: "good",
        overall_condition: "approved",
        photos: [],
        businessId: OTHER,
        branchId: otherSeed.branchId,
        driverId: otherSeed.driverId,
        vehicleId: otherSeed.vehicleId,
      },
    });

    // Red before: 403 "não pertence a esta empresa", which confirmed the id.
    const response = await remove(foreign.id);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual((await remove(randomUUID())).json());
    expect(response.json().code).toBe("VEHICLE_CHECKLIST_NOT_FOUND");
    expect(await prisma.vehicleChecklist.count({ where: { id: foreign.id } })).toBe(1);
  });

  it("refuses the driver as a permission, and deletes for the manager", async () => {
    const current = await seedChecklist({ mileage: 16_990, at: new Date(Date.now() - 3 * DAY) });

    const driver = await remove(current, seed.driverToken);

    expect(driver.statusCode).toBe(403);
    expect(driver.body).toContain("PERMISSION_DENIED");

    const readOnly = await remove(current, readOnlyToken);

    expect(readOnly.statusCode).toBe(403);
    expect(await prisma.vehicleChecklist.count({ where: { id: current } })).toBe(1);

    const manager = await remove(current);

    expect(manager.statusCode).toBe(200);
    expect(await prisma.vehicleChecklist.count({ where: { id: current } })).toBe(0);
  });
});

describe("POST create-vehicle-checklist — the date", () => {
  it("refuses a checklist dated after the company's today, with its code", async () => {
    const response = await create(
      createBody({ checklist_date: new Date(Date.now() + 36 * HOUR).toISOString() }),
    );

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("CHECKLIST_DATE_IN_FUTURE");
    expect(await vehicleMileage()).not.toBe(30_000);
  });

  it("refuses a date-only tomorrow", async () => {
    // Red before: accepted with 201 and shown as tomorrow.
    const response = await create(createBody({ checklist_date: companyTomorrow() }));

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("CHECKLIST_DATE_IN_FUTURE");
    expect(await vehicleMileage()).not.toBe(30_000);
  });
});

describe("POST create-vehicle-checklist — links of another company", () => {
  it("answers a foreign vehicle or driver exactly like an unknown one", async () => {
    const cases: Array<[string, string, string]> = [
      ["vehicleId", otherSeed.vehicleId, "VEHICLE_NOT_FOUND"],
      ["driverId", otherSeed.driverId, "DRIVER_NOT_FOUND"],
    ];

    for (const [field, foreignId, code] of cases) {
      const foreign = await create(createBody({ [field]: foreignId }));
      const unknown = await create(createBody({ [field]: randomUUID() }));

      expect(foreign.statusCode, `${field}: ${foreign.body}`).toBe(400);
      expect(foreign.json(), field).toEqual(unknown.json());
      expect(foreign.json().code, field).toBe(code);
    }

    expect(await vehicleMileage()).not.toBe(30_000);
  });
});

describe("PATCH update-vehicle-checklist — moving a checklist in time", () => {
  // A vehicle of its own, reading 30 000, with this history:
  //   12 days ago 27 000 · 10 days ago 27 900 · 8 days ago 28 200 · yesterday 30 000
  let truckId = "";
  let middle = "";
  let late = "";
  let newest = "";

  const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

  beforeAll(async () => {
    truckId = await seedVehicle(30_000);

    await seedChecklist({ mileage: 27_000, at: daysAgo(12), vehicleId: truckId });
    middle = await seedChecklist({ mileage: 27_900, at: daysAgo(10), vehicleId: truckId });
    late = await seedChecklist({ mileage: 28_200, at: daysAgo(8), vehicleId: truckId });
    newest = await seedChecklist({ mileage: 30_000, at: daysAgo(1), vehicleId: truckId });
  });

  const storedDate = async (id: string) =>
    (await prisma.vehicleChecklist.findUniqueOrThrow({ where: { id } })).checklist_date;

  it("refuses a move that puts the reading out of order", async () => {
    // Red before: only a changed reading was checked; both moves returned 200.
    const before = await storedDate(late);

    const tooEarly = await patch(late, { checklist_date: daysAgo(20).toISOString() });

    expect(tooEarly.statusCode, tooEarly.body).toBe(400);
    // Its own code and a sentence about the date's neighbours: the km was
    // not touched, and "must be greater than the vehicle's current mileage"
    // explained nothing.
    expect(tooEarly.json().code).toBe("VEHICLE_MILEAGE_OUT_OF_ORDER");
    expect(tooEarly.json().message).toContain("menor que 27.000 km");
    expect(await storedDate(late)).toEqual(before);

    const newestTooEarly = await patch(newest, { checklist_date: daysAgo(9).toISOString() });

    expect(newestTooEarly.statusCode, newestTooEarly.body).toBe(400);
  });

  it("accepts a move that keeps the order, the newest record's included", async () => {
    const moved = daysAgo(11);
    const response = await patch(middle, { checklist_date: moved.toISOString() });

    expect(response.statusCode, response.body).toBe(200);
    expect(await storedDate(middle)).toEqual(moved);

    // Its reading equals the odometer, with nothing after it: the forward
    // rule alone would refuse it; a date move must not.
    const newestMoved = await patch(newest, { checklist_date: daysAgo(2).toISOString() });

    expect(newestMoved.statusCode, newestMoved.body).toBe(200);

    const truck = await prisma.vehicle.findUniqueOrThrow({ where: { id: truckId } });

    expect(truck.current_mileage).toBe(30_000);
  });
});

describe("the odometer a checklist leaves", () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

  const remove = (checklistId: string) =>
    app.inject({
      method: "DELETE",
      url: `/vehicle-checklist/delete-vehicle-checklist/${checklistId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${seed.managerToken}` },
    });

  it("goes back to the readings left when the checklist that set it is deleted", async () => {
    // 38 000 · 39 000 · then 45 000 typed for 39 500, which set the odometer.
    const truck = await seedVehicle(45_000);

    await seedChecklist({ mileage: 38_000, at: daysAgo(10), vehicleId: truck });
    await seedChecklist({ mileage: 39_000, at: daysAgo(5), vehicleId: truck });
    const typo = await seedChecklist({ mileage: 45_000, at: daysAgo(1), vehicleId: truck });

    // Red before: the vehicle stayed at 45 000, and every later record at the
    // real ~39 500 km was refused until a MASTER edited the vehicle.
    const response = await remove(typo);

    expect(response.statusCode, response.body).toBe(200);
    expect(await vehicleMileage(truck)).toBe(39_000);
  });

  it("leaves an odometer the deleted checklist did not set", async () => {
    const truck = await seedVehicle(50_000);
    const older = await seedChecklist({ mileage: 49_000, at: daysAgo(3), vehicleId: truck });

    expect((await remove(older)).statusCode).toBe(200);
    expect(await vehicleMileage(truck)).toBe(50_000);
  });

  it("goes back on the truck a checklist is moved away from, and moves the one it lands on", async () => {
    const wrongTruck = await seedVehicle(60_000);
    const rightTruck = await seedVehicle(12_000);

    await seedChecklist({ mileage: 58_000, at: daysAgo(6), vehicleId: wrongTruck });
    const misplaced = await seedChecklist({ mileage: 60_000, at: daysAgo(2), vehicleId: wrongTruck });

    // Red before: the wrong truck kept 60 000.
    const response = await patch(misplaced, { vehicleId: rightTruck, current_mileage: 12_400 });

    expect(response.statusCode, response.body).toBe(200);
    expect(await vehicleMileage(wrongTruck)).toBe(58_000);
    expect(await vehicleMileage(rightTruck)).toBe(12_400);
  });
});

describe("the published document of the checklist routes", () => {
  // Decision 11.3: the documented refusals are the bodies the routes send.
  // Red before: create's 400 listed, for everyone, a BRANCH_NOT_FOUND the
  // branch gate answers with 404 (only the MASTER gets that 400), and the
  // edit knew no VEHICLE_MILEAGE_OUT_OF_ORDER. The guards' 403/404 codes are
  // appended by the OpenAPI transform; pinned here so they stay published.
  const responsesOf = (path: string, method: string) => {
    const document = app.swagger() as {
      paths: Record<string, Record<string, { responses?: Record<string, { description?: string }> }>>;
    };

    return document.paths[path][method].responses ?? {};
  };

  it("lists every code each status answers", () => {
    const create = responsesOf("/vehicle-checklist/create-vehicle-checklist/{businessId}", "post");
    const update = responsesOf(
      "/vehicle-checklist/update-vehicle-checklist/{checklistId}/business/{businessId}",
      "patch",
    );
    const remove = responsesOf(
      "/vehicle-checklist/delete-vehicle-checklist/{checklistId}/business/{businessId}",
      "delete",
    );
    const exported = responsesOf("/vehicle-checklist/export-vehicle-checklist", "get");

    for (const code of ["TENANT_NOT_FOUND", "BRANCH_NOT_FOUND", "BUSINESS_NOT_FOUND"]) {
      expect(create["404"]?.description, code).toContain(code);
    }

    expect(create["400"]?.description).toContain("só o MASTER");

    for (const code of [
      "BRANCH_INACTIVE",
      "VEHICLE_NOT_ASSIGNED_TO_DRIVER",
      "PERMISSION_DENIED",
      "MODULE_NOT_ENABLED",
      "TENANT_INACTIVE",
      "TENANT_ACCESS_DENIED",
    ]) {
      expect(create["403"]?.description, code).toContain(code);
    }

    for (const [route, responses] of [
      ["update", update],
      ["delete", remove],
      ["export", exported],
    ] as const) {
      for (const code of ["PERMISSION_DENIED", "MODULE_NOT_ENABLED", "TENANT_ACCESS_DENIED"]) {
        expect(responses["403"]?.description, `${route} ${code}`).toContain(code);
      }
    }

    // Drivers are refused by the export's guard with PERMISSION_DENIED
    // (decision 4.1), and the document says so.
    expect(exported["403"]?.description).not.toContain("DRIVER_CANNOT_EXPORT");
    expect(exported["403"]?.description).toContain("Motoristas");
    expect(update["400"]?.description).toContain("VEHICLE_MILEAGE_OUT_OF_ORDER");
    expect(update["404"]?.description).toContain("VEHICLE_CHECKLIST_NOT_FOUND");
  });
});
