import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import auth from "@/config/auth";
import { businessDayRange } from "@/shared/time/business-day";
import type { UploadService } from "@/shared/services/upload-service";

import { fakeJpeg } from "./support/fleet-driver-seed";

/**
 * Editing a refueling that already happened (FLEET-FUEL-1), over real HTTP.
 *
 * "Only active vehicles can be fueled" is a rule about a NEW fueling. Applied
 * to an edit, it refused correcting the price of last month's fueling of a
 * truck that is now inactive or blocked, of a driver who left, or of a
 * branch that was closed — the web form resent every link, unchanged, and
 * each one was checked against today. Now the state is checked only for a
 * link the edit changes.
 *
 * Also here: the date limit is the company's today (decision 1.2), and the
 * previous-fueling lookup behind the details dialog works for the MASTER
 * without opening another company's history.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe300-0000-7000-8000-00000000000a";
const OTHER = "018fe300-0000-7000-8000-00000000000b";

const BRANCH = "018fe300-0000-7000-8000-0000000000b1";
const CLOSED_BRANCH = "018fe300-0000-7000-8000-0000000000b2";
const OTHER_BRANCH = "018fe300-0000-7000-8000-0000000000b9";

const TRUCK = "018fe300-0000-7000-8000-0000000000c1";
const SOLD_TRUCK = "018fe300-0000-7000-8000-0000000000c2";
const OTHER_TRUCK = "018fe300-0000-7000-8000-0000000000c9";
const DRIVERS_TRUCK = "018fe300-0000-7000-8000-0000000000c3";

const DRIVER = "018fe300-0000-7000-8000-0000000000d1";
const FORMER_DRIVER = "018fe300-0000-7000-8000-0000000000d2";
const OTHER_DRIVER = "018fe300-0000-7000-8000-0000000000d9";

const DIESEL = "018fe300-0000-7000-8000-0000000000e1";
const OTHER_DIESEL = "018fe300-0000-7000-8000-0000000000e9";

let managerToken = "";
let masterToken = "";
let otherManagerToken = "";
let driverToken = "";
let readOnlyToken = "";

let historical = "";

let cnpjSeq = 0;

async function seedBusiness(id: string) {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(61222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "FLEET", enabled: true },
  });
}

async function seedBranch(id: string, businessId: string, active: boolean) {
  cnpjSeq += 1;

  await prisma.branch.create({
    data: {
      id,
      corporate_reason: `Filial ${id.slice(-2)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(71222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      is_active: active,
      businessId,
    },
  });
}

async function seedDriver(id: string, businessId: string, active: boolean) {
  await prisma.driver.create({
    data: {
      id,
      name: `Motorista ${id.slice(-2)}`,
      birth_date: new Date("1990-01-01"),
      cnh: `${id.slice(-6)}cnh`,
      cpf: `${id.slice(-6)}cpf`,
      rg: `${id.slice(-6)}rg`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: active ? "ACTIVE" : "INACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });
}

async function seedVehicle(
  id: string,
  businessId: string,
  status: "ACTIVE" | "INACTIVE" | "BLOCKED",
  fuelTypeId: string,
  driverId?: string,
) {
  await prisma.vehicle.create({
    data: {
      id,
      license_plate: `P${id.slice(-6)}`,
      description: `Caminhão ${id.slice(-2)}`,
      brand: "Marca",
      model: "Modelo",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED",
      current_mileage: 50_000,
      maintenance_interval_km: 10_000,
      maintenance_interval_months: 6,
      renavam: `${id.slice(-8)}r`,
      manufacturing_year: new Date("2019-01-01"),
      model_year: new Date("2020-01-01"),
      km_per_liter: 3,
      number_of_axles: 2,
      status,
      businessId,
      fuelTypeId,
      driverId: driverId ?? null,
    },
  });
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  driverId?: string,
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
      driverId: driverId ?? null,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "15m" },
  );
}

function patch(body: Record<string, unknown>, token = managerToken, fuelId = historical) {
  return app.inject({
    method: "PATCH",
    url: `/fuel/update-fuel/${fuelId}/business/${CARRIER}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await seedBranch(BRANCH, CARRIER, true);
  await seedBranch(CLOSED_BRANCH, CARRIER, false);
  await seedBranch(OTHER_BRANCH, OTHER, true);

  await prisma.fuelType.createMany({
    data: [
      { id: DIESEL, description: "Diesel", businessId: CARRIER },
      { id: OTHER_DIESEL, description: "Diesel", businessId: OTHER },
    ],
  });

  await seedDriver(DRIVER, CARRIER, true);
  await seedDriver(FORMER_DRIVER, CARRIER, false);
  await seedDriver(OTHER_DRIVER, OTHER, true);

  await seedVehicle(TRUCK, CARRIER, "ACTIVE", DIESEL);
  await seedVehicle(SOLD_TRUCK, CARRIER, "INACTIVE", DIESEL);
  await seedVehicle(OTHER_TRUCK, OTHER, "ACTIVE", OTHER_DIESEL);
  await seedVehicle(DRIVERS_TRUCK, CARRIER, "ACTIVE", DIESEL, DRIVER);

  managerToken = await seedUser("BUSINESS_ADMIN", CARRIER);
  masterToken = await seedUser("MASTER", null);
  otherManagerToken = await seedUser("BUSINESS_ADMIN", OTHER);
  driverToken = await seedUser("BUSINESS_USER", CARRIER, DRIVER);

  const readOnlyProfile = await prisma.profileAccess.create({
    data: {
      name: "Somente leitura",
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "fuel_manage",
            action: "fuel_manage",
            canRead: true,
            canWrite: false,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  readOnlyToken = await seedUser("BUSINESS_USER", CARRIER);
  await prisma.user.updateMany({
    where: { businessId: CARRIER, role: "BUSINESS_USER", driverId: null },
    data: { profileAccessId: readOnlyProfile.id },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

beforeEach(async () => {
  // Last month's fueling of a truck that has since been sold (INACTIVE), by
  // a driver who has left, at a branch that was closed.
  const fuel = await prisma.fuel.create({
    data: {
      current_mileage: 40_000,
      liters_amount: 100,
      price_per_liter: 5,
      total_amount: 500,
      odometer_photo: `odometerPhotos/${CARRIER}/antigo.webp`,
      refueling_date: new Date(Date.now() - 30 * 86_400_000),
      businessId: CARRIER,
      branchId: CLOSED_BRANCH,
      vehicleId: SOLD_TRUCK,
      driverId: FORMER_DRIVER,
      fuelTypeId: DIESEL,
      created_from: "WEB_DASHBOARD",
    },
  });

  historical = fuel.id;
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("PATCH /fuel/update-fuel — a historical record keeps its links", () => {
  it("corrects the price of an inactive vehicle's fueling", async () => {
    const response = await patch({ price_per_liter: "5.49" });

    expect(response.statusCode).toBe(200);

    const stored = await prisma.fuel.findUniqueOrThrow({ where: { id: historical } });

    expect(stored.price_per_liter.toNumber()).toBe(5.49);
    expect(stored.total_amount.toNumber()).toBe(549);
  });

  it("accepts the links resent unchanged, as the old form did", async () => {
    const response = await patch({
      price_per_liter: "5.10",
      vehicleId: SOLD_TRUCK,
      driverId: FORMER_DRIVER,
      branchId: CLOSED_BRANCH,
      fuelTypeId: DIESEL,
    });

    expect(response.statusCode).toBe(200);
  });

  it("still refuses MOVING the record to an inactive vehicle", async () => {
    const other = await prisma.fuel.create({
      data: {
        current_mileage: 60_000,
        liters_amount: 10,
        price_per_liter: 5,
        total_amount: 50,
        odometer_photo: `odometerPhotos/${CARRIER}/x.webp`,
        businessId: CARRIER,
        branchId: BRANCH,
        vehicleId: TRUCK,
        driverId: DRIVER,
        fuelTypeId: DIESEL,
        created_from: "WEB_DASHBOARD",
      },
    });

    const response = await patch({ vehicleId: SOLD_TRUCK }, managerToken, other.id);

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("ativo");
  });

  it("still refuses moving it to an inactive driver or a closed branch", async () => {
    const other = await prisma.fuel.create({
      data: {
        current_mileage: 60_000,
        liters_amount: 10,
        price_per_liter: 5,
        total_amount: 50,
        odometer_photo: `odometerPhotos/${CARRIER}/y.webp`,
        businessId: CARRIER,
        branchId: BRANCH,
        vehicleId: TRUCK,
        driverId: DRIVER,
        fuelTypeId: DIESEL,
        created_from: "WEB_DASHBOARD",
      },
    });

    const toFormerDriver = await patch({ driverId: FORMER_DRIVER }, managerToken, other.id);

    expect(toFormerDriver.statusCode).toBe(422);
    expect(toFormerDriver.body).toContain("DRIVER_INACTIVE");

    const toClosedBranch = await patch({ branchId: CLOSED_BRANCH }, managerToken, other.id);

    expect(toClosedBranch.statusCode).toBe(409);
    expect(toClosedBranch.body).toContain("BRANCH_INACTIVE");
  });

  it("ignores server-owned fields in the body (photo path, AI verdict, location audit)", async () => {
    const response = await patch({
      price_per_liter: "5.20",
      odometer_photo: `checklistPhotos/${OTHER}/segredo.webp`,
      odometer_verified: true,
      location_edited_by: randomUUID(),
      location_source: "GPS_AUTO",
    });

    expect(response.statusCode).toBe(200);

    const stored = await prisma.fuel.findUniqueOrThrow({ where: { id: historical } });

    // The record still points at its own photo: the list signs whatever key
    // is stored, so a foreign key here was a read of another company's file.
    expect(stored.odometer_photo).toBe(`odometerPhotos/${CARRIER}/antigo.webp`);
    expect(stored.odometer_verified).toBe(false);
    expect(stored.location_edited_by).toBeNull();
    expect(stored.location_source).toBeNull();
  });

  it("refuses links of another company", async () => {
    const response = await patch({ driverId: OTHER_DRIVER });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("DRIVER_NOT_FOUND");

    const stored = await prisma.fuel.findUniqueOrThrow({ where: { id: historical } });

    expect(stored.driverId).toBe(FORMER_DRIVER);
  });

  it("refuses a date after the company's today", async () => {
    // A day and a half ahead is tomorrow in every Brazilian zone.
    const response = await patch({
      refueling_date: new Date(Date.now() + 36 * 3_600_000).toISOString(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("REFUELING_DATE_IN_FUTURE");
  });

  it("answers another company's manager with 403 and a missing id with 404", async () => {
    expect((await patch({ price_per_liter: "4" }, otherManagerToken)).statusCode).toBe(403);
    expect((await patch({ price_per_liter: "4" }, readOnlyToken)).statusCode).toBe(403);
    expect((await patch({ price_per_liter: "4" }, driverToken)).statusCode).not.toBe(200);

    const missing = await patch({ price_per_liter: "4" }, managerToken, randomUUID());

    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain("FUEL_NOT_FOUND");
  });
});

describe("the km of a refueling on its vehicle's timeline", () => {
  // A truck of its own, reseeded before every case so each one stands alone:
  // refuelings 10, 5 and 2 days ago, and an odometer of 50.000 from the
  // registration, past all of them. The middle one was typed 45.500
  // instead of 44.500.
  const TIMELINE_TRUCK = "018fe300-0000-7000-8000-0000000000c4";
  const TARGET_TRUCK = "018fe300-0000-7000-8000-0000000000c5";

  const readings: Record<"first" | "typo" | "last", string> = {
    first: "",
    typo: "",
    last: "",
  };

  const storedKeys: string[] = [];

  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

  const refuel = async (mileage: number, when: Date, vehicleId = TIMELINE_TRUCK) =>
    (
      await prisma.fuel.create({
        data: {
          current_mileage: mileage,
          liters_amount: 50,
          price_per_liter: 5,
          total_amount: 250,
          odometer_photo: `odometerPhotos/${CARRIER}/linha-${mileage}.webp`,
          refueling_date: when,
          businessId: CARRIER,
          branchId: BRANCH,
          vehicleId,
          driverId: DRIVER,
          fuelTypeId: DIESEL,
          created_from: "WEB_DASHBOARD",
        },
      })
    ).id;

  const odometer = async (vehicleId = TIMELINE_TRUCK) =>
    (await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } }))
      .current_mileage;

  const setOdometer = (current_mileage: number, vehicleId = TIMELINE_TRUCK) =>
    prisma.vehicle.update({ where: { id: vehicleId }, data: { current_mileage } });

  const checklistAt = (mileage: number, when: Date) =>
    prisma.vehicleChecklist.create({
      data: {
        current_mileage: mileage,
        checklist_date: when,
        tires_condition: "good",
        bumpers_condition: "good",
        windshield_condition: "good",
        mirrors_condition: "good",
        steering_wheel_condition: "good",
        battery_condition: "good",
        spare_tire_condition: "good",
        overall_condition: "approved",
        businessId: CARRIER,
        branchId: BRANCH,
        vehicleId: TIMELINE_TRUCK,
        driverId: DRIVER,
      },
    });

  /** A create as the web posts it, with a photo already in storage. */
  async function create(mileage: number, when: Date) {
    const uploads = container.resolve<UploadService>("UploadService");
    const key = `odometerPhotos/${CARRIER}/${Date.now()}-linha-${randomUUID()}.jpg`;

    await uploads.putObject(key, fakeJpeg(), "image/jpeg");
    storedKeys.push(key);

    return app.inject({
      method: "POST",
      url: `/fuel/create-fuel/${CARRIER}`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: {
        current_mileage: mileage,
        liters_amount: 40,
        price_per_liter: 5.899,
        refueling_date: when.toISOString(),
        businessId: CARRIER,
        created_from: "WEB_DASHBOARD",
        branchId: BRANCH,
        vehicleId: TIMELINE_TRUCK,
        driverId: DRIVER,
        fuelTypeId: DIESEL,
        photo: { key },
      },
    });
  }

  beforeAll(async () => {
    await seedVehicle(TIMELINE_TRUCK, CARRIER, "ACTIVE", DIESEL);
    await seedVehicle(TARGET_TRUCK, CARRIER, "ACTIVE", DIESEL);
  });

  beforeEach(async () => {
    const trucks = [TIMELINE_TRUCK, TARGET_TRUCK];

    await prisma.fuel.deleteMany({ where: { vehicleId: { in: trucks } } });
    await prisma.vehicleChecklist.deleteMany({ where: { vehicleId: { in: trucks } } });
    await prisma.vehicle.updateMany({
      where: { id: { in: trucks } },
      data: { current_mileage: 50_000, last_maintenance_mileage: null },
    });

    readings.first = await refuel(40_000, daysAgo(10));
    readings.typo = await refuel(45_500, daysAgo(5));
    readings.last = await refuel(48_000, daysAgo(2));
  });

  afterAll(async () => {
    const uploads = container.resolve<UploadService>("UploadService");

    await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));
  });

  describe("PATCH /fuel/update-fuel — correcting a past refueling", () => {
    it("accepts a lower reading that fits between its neighbours, and leaves the odometer", async () => {
      // Red before: "must be above the vehicle's 50.000 km" refused any past km.
      // Downwards also proves the record is left out of its own neighbours:
      // counted, its stored 45.500 would be the reading "before" it.
      const response = await patch({ current_mileage: "44500" }, managerToken, readings.typo);

      expect(response.statusCode, response.body).toBe(200);

      const stored = await prisma.fuel.findUniqueOrThrow({ where: { id: readings.typo } });

      expect(stored.current_mileage).toBe(44_500);
      expect(await odometer()).toBe(50_000);
    });

    it("refuses a reading past the next refueling or below the previous one", async () => {
      const pastNext = await patch({ current_mileage: "48500" }, managerToken, readings.typo);

      expect(pastNext.statusCode).toBe(400);
      expect(pastNext.json().code).toBe("VEHICLE_MILEAGE_INVALID");
      // Red before: "deve ser maior que a quilometragem atual do veículo",
      // which told the manager a correction was impossible.
      expect(pastNext.json().message).toContain("entre a leitura anterior e a seguinte");
      expect(pastNext.json().message).not.toContain("deve ser maior");

      const belowPrevious = await patch({ current_mileage: "39000" }, managerToken, readings.typo);

      expect(belowPrevious.statusCode).toBe(400);
      expect(belowPrevious.json().code).toBe("VEHICLE_MILEAGE_INVALID");

      const stored = await prisma.fuel.findUniqueOrThrow({ where: { id: readings.typo } });

      expect(stored.current_mileage).toBe(45_500);
    });

    it("refuses raising a past refueling above the odometer, past the later one", async () => {
      const response = await patch({ current_mileage: "51000" }, managerToken, readings.typo);

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("VEHICLE_MILEAGE_INVALID");
      expect(await odometer()).toBe(50_000);

      const stored = await prisma.fuel.findUniqueOrThrow({ where: { id: readings.typo } });

      expect(stored.current_mileage).toBe(45_500);
    });

    it("corrects the newest refueling below an odometer it did not set, and leaves it", async () => {
      // The 50.000 came from the vehicle's registration, not this refueling.
      const response = await patch({ current_mileage: "47000" }, managerToken, readings.last);

      expect(response.statusCode, response.body).toBe(200);
      expect(await odometer()).toBe(50_000);
    });

    it("moves the odometer forward for a reading ahead of it, and back with its correction", async () => {
      const ahead = await patch({ current_mileage: "51000" }, managerToken, readings.last);

      expect(ahead.statusCode, ahead.body).toBe(200);
      expect(await odometer()).toBe(51_000);

      // A typo on the latest refueling used to freeze the odometer.
      const back = await patch({ current_mileage: "49000" }, managerToken, readings.last);

      expect(back.statusCode, back.body).toBe(200);
      expect(await odometer()).toBe(49_000);
    });

    it("never takes the newest below an earlier reading, a checklist included", async () => {
      await patch({ current_mileage: "51000" }, managerToken, readings.last);

      // A checklist of 3 days ago read 47.500: the refueling of 2 days ago
      // cannot read less, and neither can the odometer it drags along.
      await checklistAt(47_500, daysAgo(3));

      const belowChecklist = await patch({ current_mileage: "47000" }, managerToken, readings.last);

      expect(belowChecklist.statusCode).toBe(400);
      expect(belowChecklist.json().code).toBe("VEHICLE_MILEAGE_INVALID");
      expect(await odometer()).toBe(51_000);

      const aboveIt = await patch({ current_mileage: "48000" }, managerToken, readings.last);

      expect(aboveIt.statusCode, aboveIt.body).toBe(200);
      expect(await odometer()).toBe(48_000);
    });

    it("checks a date-only edit at the new date", async () => {
      // Red before (200): with the km unchanged nothing was placed, and the
      // 45.500 of 5 days ago moved before the 40.000 of 10 days ago.
      const beforeFirst = await patch(
        { refueling_date: daysAgo(12).toISOString() },
        managerToken,
        readings.typo,
      );

      expect(beforeFirst.statusCode).toBe(400);
      expect(beforeFirst.json().code).toBe("VEHICLE_MILEAGE_INVALID");

      const unchanged = await prisma.fuel.findUniqueOrThrow({ where: { id: readings.typo } });

      expect(unchanged.refueling_date.getTime()).toBeGreaterThan(daysAgo(6).getTime());

      // A move that keeps the order is a plain correction.
      const inOrder = await patch(
        { refueling_date: daysAgo(6).toISOString() },
        managerToken,
        readings.typo,
      );

      expect(inOrder.statusCode, inOrder.body).toBe(200);
      expect(await odometer()).toBe(50_000);
    });

    it("gives back the odometer a past refueling set, when corrected between later readings", async () => {
      // A 510.000 typed for 51.000 on the refueling of 4 days ago, as the old
      // create stored it: the odometer jumped with it.
      const frozen = await refuel(510_000, daysAgo(4));
      await setOdometer(510_000);

      const response = await patch({ current_mileage: "46000" }, managerToken, frozen);

      // Red before: the correction fit between 45.500 and 48.000 and left
      // the odometer at 510.000, so every later record was still refused.
      expect(response.statusCode, response.body).toBe(200);
      expect(await odometer()).toBe(48_000);
    });

    it("gives the truck it leaves back the odometer a moved refueling set", async () => {
      // Typed on the wrong truck with the other truck's km.
      await setOdometer(120_000, TARGET_TRUCK);
      const wrongTruck = await refuel(121_000, daysAgo(1));
      await setOdometer(121_000);

      const response = await patch({ vehicleId: TARGET_TRUCK }, managerToken, wrongTruck);

      expect(response.statusCode, response.body).toBe(200);
      expect(await odometer(TARGET_TRUCK)).toBe(121_000);
      // Red before: the source truck kept 121.000, a km no record supports.
      expect(await odometer()).toBe(48_000);
    });
  });

  describe("POST /fuel/create-fuel — a back-dated refueling", () => {
    it("is refused above the next day's reading, and the odometer stays", async () => {
      // Red before (201): the forward rule ran first, so 510.000 dated 4
      // days ago moved the odometer to 510.000 past the 48.000 of 2 days ago.
      const typo = await create(510_000, daysAgo(4));

      expect(typo.statusCode, typo.body).toBe(400);
      expect(typo.json().code).toBe("VEHICLE_MILEAGE_INVALID");
      expect(await odometer()).toBe(50_000);
      expect(await prisma.fuel.count({ where: { vehicleId: TIMELINE_TRUCK } })).toBe(3);

      const between = await create(46_000, daysAgo(4));

      expect(between.statusCode, between.body).toBe(201);
      expect(await odometer()).toBe(50_000);
    });

    it("still passes readings of its own day, as a web date of today did", async () => {
      // The web sends today's local midnight; the app's checklist of this
      // morning is "after" it, on the same day.
      const midnight = businessDayRange(new Date(), "America/Sao_Paulo").start;

      await checklistAt(50_100, new Date(midnight.getTime() + 1_000));
      await setOdometer(50_100);

      const response = await create(50_300, midnight);

      expect(response.statusCode, response.body).toBe(201);
      expect(await odometer()).toBe(50_300);
    });
  });

  describe("DELETE /fuel/delete-fuel", () => {
    const remove = (fuelId: string) =>
      app.inject({
        method: "DELETE",
        url: `/fuel/delete-fuel/${fuelId}/business/${CARRIER}`,
        headers: { authorization: `Bearer ${managerToken}` },
      });

    it("takes the km of a refueling that set the odometer with it", async () => {
      const typo = await refuel(150_000, daysAgo(1));
      await setOdometer(150_000);

      const response = await remove(typo);

      // Red before: the odometer stayed at 150.000.
      expect(response.statusCode, response.body).toBe(200);
      expect(await odometer()).toBe(48_000);
    });

    it("never below the last maintenance, and not when something else set it", async () => {
      const typo = await refuel(150_000, daysAgo(1));
      await setOdometer(150_000);
      await prisma.vehicle.update({
        where: { id: TIMELINE_TRUCK },
        data: { last_maintenance_mileage: 49_000 },
      });

      expect((await remove(typo)).statusCode).toBe(200);
      expect(await odometer()).toBe(49_000);

      // The 50.000 of the registration: no refueling set it.
      await setOdometer(50_000);

      expect((await remove(readings.last)).statusCode).toBe(200);
      expect(await odometer()).toBe(50_000);
    });
  });
});

describe("GET /fuel/get-previous-fuel — the details dialog's consumption", () => {
  const previous = (vehicleId: string, businessId: string, token: string) =>
    app.inject({
      method: "GET",
      url: `/fuel/get-previous-fuel/${vehicleId}?date=${encodeURIComponent(
        new Date().toISOString(),
      )}&businessId=${businessId}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it("works for the MASTER on the company he selected", async () => {
    const response = await previous(SOLD_TRUCK, CARRIER, masterToken);

    expect(response.statusCode).toBe(200);
    expect(response.json()?.vehicleId).toBe(SOLD_TRUCK);
  });

  it("keeps another company's vehicle out of reach", async () => {
    const foreignVehicle = await previous(OTHER_TRUCK, CARRIER, managerToken);

    expect(foreignVehicle.statusCode).toBe(404);

    const foreignCompany = await previous(OTHER_TRUCK, OTHER, managerToken);

    expect(foreignCompany.statusCode).toBe(403);
  });

  it("shows a driver only the vehicle they operate (decision 4.4)", async () => {
    expect((await previous(DRIVERS_TRUCK, CARRIER, driverToken)).statusCode).toBe(200);

    // Another truck of the same company: its fuelings are not the driver's.
    // Refused with the code the vehicle routes give the same case.
    const colleagues = await previous(SOLD_TRUCK, CARRIER, driverToken);

    expect(colleagues.statusCode).toBe(403);
    expect(colleagues.json().code).toBe("VEHICLE_NOT_ASSIGNED_TO_DRIVER");
  });

  it("gives a driver a colleague's refueling of their truck as a reading only (DRV-SCOPE-1)", async () => {
    // A colleague fueled the driver's truck an hour ago.
    await prisma.fuel.create({
      data: {
        current_mileage: 51_000,
        liters_amount: 120,
        price_per_liter: 6.19,
        total_amount: 742.8,
        odometer_photo: `odometerPhotos/${CARRIER}/colega.webp`,
        notes: "Posto do trevo, pago no cartão do colega",
        latitude: -23.55,
        longitude: -46.63,
        refueling_date: new Date(Date.now() - 3_600_000),
        businessId: CARRIER,
        branchId: BRANCH,
        vehicleId: DRIVERS_TRUCK,
        driverId: FORMER_DRIVER,
        fuelTypeId: DIESEL,
        created_from: "MOBILE_APP",
      },
    });

    const response = await previous(DRIVERS_TRUCK, CARRIER, driverToken);

    expect(response.statusCode).toBe(200);

    const reading = response.json();

    // What the consumption needs.
    expect(reading).toMatchObject({
      vehicleId: DRIVERS_TRUCK,
      current_mileage: 51_000,
      liters_amount: 120,
    });
    expect(typeof reading.refueling_date).toBe("string");

    // Red before: the whole row went out — who fueled, the notes, the price,
    // the photo and the record's id.
    for (const hidden of [
      "id",
      "driverId",
      "notes",
      "price_per_liter",
      "total_amount",
      "odometer_photo",
      "latitude",
      "branchId",
    ]) {
      expect(reading, hidden).not.toHaveProperty(hidden);
    }
  });

  it("refuses an unreadable date instead of failing with 500", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/fuel/get-previous-fuel/${TRUCK}?date=ontem&businessId=${CARRIER}`,
      headers: { authorization: `Bearer ${managerToken}` },
    });

    expect(response.statusCode).toBe(400);
  });
});
