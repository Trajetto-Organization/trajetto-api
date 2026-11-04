import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";
import { createPrismaClient } from "@/shared/database/database-client";
import { businessDateKey } from "@/shared/time/business-day";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * The record branch of the route's checklist and refuelling, over real HTTP
 * and Postgres (finding of the closing review and contract C1, 03/11/2026).
 *
 * Branch is optional on the vehicle and on the driver, but the driver's
 * checklist and refuelling were refused with 400 BRANCH_REQUIRED when
 * neither had one — permanent for the app, so with the checklist required
 * the route never started. Now:
 *
 * - the record falls back to the company's single ACTIVE branch;
 * - when even that names nothing (several active branches), releasing the
 *   route — or changing the vehicle or driver of a released one — answers
 *   409 ROUTE_BRANCH_REQUIRED naming the plate and the driver, so the
 *   dispatcher completes the record before the driver is at the truck;
 * - a company that does not ask for the checklist is never asked.
 *
 * Another company's only branch never lends itself: OTHER has exactly one
 * active branch while CARRIER, with two, is refused.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let uploads: UploadService;
const storedKeys: string[] = [];

const CARRIER = "018fb600-0000-7000-8000-00000000000a";
const OTHER = "018fb600-0000-7000-8000-00000000000b";

let carrier: FleetDriverSeed;
let other: FleetDriverSeed;

let plate = "";
let branchlessTruck = "";
let branchlessTruckPlate = "";
let shipperId = "";
let otherShipperId = "";
let mileage = 1_000;

const today = () => businessDateKey(new Date(), "America/Sao_Paulo");

const post = (url: string, token: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });

const patch = (url: string, token: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "PATCH",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });

async function storedPhoto(
  businessId: string,
  folder: "odometerPhotos" | "checklistPhotos",
): Promise<string> {
  const key = `${folder}/${businessId}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

async function checklistBody(seed: FleetDriverSeed) {
  const photos = await Promise.all(
    ["current_mileage", "fuel_level_adequate", "tires_condition"].map(
      async (fieldName) => ({
        key: await storedPhoto(seed.businessId, "checklistPhotos"),
        fieldName,
      }),
    ),
  );

  mileage += 10;

  return {
    client_submission_id: randomUUID(),
    vehicleId: seed.vehicleId,
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

async function fuelBody(seed: FleetDriverSeed) {
  const key = await storedPhoto(seed.businessId, "odometerPhotos");

  mileage += 10;

  return {
    client_submission_id: randomUUID(),
    current_mileage: mileage,
    liters_amount: 50,
    price_per_liter: 6.5,
    total_amount: 325,
    refueling_date: new Date(Date.now() - 60_000).toISOString(),
    vehicleId: seed.vehicleId,
    driverId: seed.driverId,
    fuelTypeId: seed.fuelTypeId,
    latitude: -23.55,
    longitude: -46.63,
    created_from: "MOBILE_APP",
    photo: { key },
  };
}

async function extraBranch(seed: FleetDriverSeed, n: number): Promise<string> {
  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial Extra ${n} ${randomUUID().slice(0, 6)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `${String(n).padStart(2, "0")}${randomUUID().replace(/\D/g, "").padEnd(12, "7").slice(0, 12)}`,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-extra-${randomUUID()}@exemplo.com.br`,
      businessId: seed.businessId,
    },
    select: { id: true },
  });

  return branch.id;
}

/** A PLANNED route with one stop, created through the API. */
async function plannedRoute(
  seed: FleetDriverSeed,
  shipper: string,
  vehicleId = seed.vehicleId,
): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: `Cliente ${randomUUID().slice(0, 6)}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: seed.businessId,
      shipperId: shipper,
    },
    select: { id: true },
  });

  const created = await post(
    `/route/create-route/${seed.businessId}`,
    seed.managerToken,
    {
      driverId: seed.driverId,
      vehicleId,
      scheduled_date: today(),
      deliveryIds: [delivery.id],
    },
  );

  expect(created.statusCode, created.body).toBe(201);

  return created.json().data.id;
}

const release = (seed: FleetDriverSeed, routeId: string) =>
  patch(
    `/route/release-route/${routeId}/business/${seed.businessId}`,
    seed.managerToken,
    { released: true },
  );

const sentence = (vehiclePlate: string) =>
  `O checklist desta empresa exige filial: defina a filial do veículo ${vehiclePlate} ou do motorista Motorista da Frota.`;

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "71888999000101",
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "71888999000202",
  });

  // What an admin leaves blank: no branch on the truck nor on the driver,
  // in both companies.
  for (const seed of [carrier, other]) {
    await prisma.vehicle.update({
      where: { id: seed.vehicleId },
      data: { branchId: null },
    });
    await prisma.driver.update({
      where: { id: seed.driverId },
      data: { branchId: null },
    });
  }

  // CARRIER asks for the departure checklist; OTHER never saved settings
  // (NONE).
  await prisma.businessSettings.create({
    data: { businessId: CARRIER, checklist_requirement: "ROUTE_START" },
  });

  const truck = await prisma.vehicle.findUniqueOrThrow({
    where: { id: carrier.vehicleId },
  });
  plate = truck.license_plate;

  const {
    id: _id,
    created_at: _created,
    updated_at: _updated,
    driverId: _driver,
    responsibleUserId: _responsible,
    ...copy
  } = truck;

  branchlessTruckPlate = randomUUID().slice(0, 7).toUpperCase();
  branchlessTruck = (
    await prisma.vehicle.create({
      data: {
        ...copy,
        branchId: null,
        license_plate: branchlessTruckPlate,
        renavam: randomUUID().slice(0, 11),
      },
      select: { id: true },
    })
  ).id;

  shipperId = (
    await prisma.shipper.create({
      data: { name: "Embarcador", businessId: CARRIER },
      select: { id: true },
    })
  ).id;
  otherShipperId = (
    await prisma.shipper.create({
      data: { name: "Embarcador", businessId: OTHER },
      select: { id: true },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));
  await app?.close();
  await prisma.$disconnect();
});

describe("a driver's record with no branch on the vehicle or the driver", () => {
  it("files the checklist under the company's single active branch", async () => {
    const response = await post(
      `/vehicle-checklist/create-vehicle-checklist/${CARRIER}`,
      carrier.driverToken,
      await checklistBody(carrier),
    );

    expect(response.statusCode, response.body).toBe(201);

    const row = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: response.json().id },
    });
    expect(row.branchId).toBe(carrier.branchId);
  });

  it("files the refuelling under the company's single active branch", async () => {
    const response = await post(
      `/fuel/create-fuel/${CARRIER}`,
      carrier.driverToken,
      await fuelBody(carrier),
    );

    expect(response.statusCode, response.body).toBe(201);

    const row = await prisma.fuel.findUniqueOrThrow({
      where: { id: response.json().id },
    });
    expect(row.branchId).toBe(carrier.branchId);
  });
});

describe("releasing a route whose checklist the company asks for", () => {
  let routeId = "";

  beforeAll(async () => {
    // A second active branch: no single one to fall back on any more.
    await extraBranch(carrier, 2);
    routeId = await plannedRoute(carrier, shipperId);
  });

  it("refuses with 409 ROUTE_BRANCH_REQUIRED naming the plate and the driver, and leaves the route planned", async () => {
    const response = await release(carrier, routeId);

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      code: "ROUTE_BRANCH_REQUIRED",
      message: sentence(plate),
    });

    const row = await prisma.route.findUniqueOrThrow({
      where: { id: routeId },
    });
    expect(row.status).toBe("PLANNED");
    expect(row.released_at).toBeNull();
  });

  it("is what the driver would have hit: the checklist is refused with 409 BRANCH_REQUIRED", async () => {
    // 409 since wave 3.7: the driver's body is fine, the company's records
    // name no active branch (the manager's blank field keeps its 400).
    const response = await post(
      `/vehicle-checklist/create-vehicle-checklist/${CARRIER}`,
      carrier.driverToken,
      await checklistBody(carrier),
    );

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("BRANCH_REQUIRED");
  });

  it("refuses the assignment shortcut the same way: it releases the route it builds", async () => {
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: `Cliente ${randomUUID().slice(0, 6)}`,
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Entregas",
        businessId: CARRIER,
        shipperId,
      },
      select: { id: true },
    });

    const response = await patch(
      `/delivery/assign-deliveries/${CARRIER}`,
      carrier.managerToken,
      {
        deliveryIds: [delivery.id],
        driverId: carrier.driverId,
        vehicleId: carrier.vehicleId,
      },
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      code: "ROUTE_BRANCH_REQUIRED",
      message: sentence(plate),
    });
    // Nothing was built: the delivery holds no stop.
    expect(
      await prisma.routeStop.count({ where: { deliveryId: delivery.id } }),
    ).toBe(0);
  });

  it("lets a planned route take a branchless vehicle: only the release asks", async () => {
    const other = await plannedRoute(carrier, shipperId);

    const response = await patch(
      `/route/update-route/${other}/business/${CARRIER}`,
      carrier.managerToken,
      { vehicleId: branchlessTruck },
    );

    expect(response.statusCode, response.body).toBe(200);
  });

  it("releases once the vehicle has a branch", async () => {
    await prisma.vehicle.update({
      where: { id: carrier.vehicleId },
      data: { branchId: carrier.branchId },
    });

    const response = await release(carrier, routeId);

    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: routeId } })).status,
    ).toBe("RELEASED");
  });

  it("refuses a crew change on the released route that leaves nothing to resolve, and keeps the crew", async () => {
    const response = await patch(
      `/route/update-route/${routeId}/business/${CARRIER}`,
      carrier.managerToken,
      { vehicleId: branchlessTruck },
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      code: "ROUTE_BRANCH_REQUIRED",
      message: sentence(branchlessTruckPlate),
    });

    const row = await prisma.route.findUniqueOrThrow({
      where: { id: routeId },
    });
    expect(row.vehicleId).toBe(carrier.vehicleId);
  });

  it("accepts the crew change once the driver has a branch", async () => {
    await prisma.driver.update({
      where: { id: carrier.driverId },
      data: { branchId: carrier.branchId },
    });

    const response = await patch(
      `/route/update-route/${routeId}/business/${CARRIER}`,
      carrier.managerToken,
      { vehicleId: branchlessTruck },
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: routeId } }))
        .vehicleId,
    ).toBe(branchlessTruck);
  });
});

describe("a route whose vehicle is filed under an inactive branch", () => {
  let inactiveBranch = "";
  let inactiveName = "";
  let routeId = "";

  beforeAll(async () => {
    // Deactivating a branch only checks its drivers' open routes (K10), so
    // a truck can keep pointing at one. The driver's own branch is active.
    inactiveBranch = await extraBranch(carrier, 4);
    inactiveName = (
      await prisma.branch.update({
        where: { id: inactiveBranch },
        data: { is_active: false },
        select: { corporate_reason: true },
      })
    ).corporate_reason;

    await prisma.vehicle.update({
      where: { id: carrier.vehicleId },
      data: { branchId: inactiveBranch },
    });
    await prisma.driver.update({
      where: { id: carrier.driverId },
      data: { branchId: carrier.branchId },
    });

    routeId = await plannedRoute(carrier, shipperId);
  });

  it("files the driver's checklist under the driver's active branch: the inactive one is skipped (wave 3.7)", async () => {
    const response = await post(
      `/vehicle-checklist/create-vehicle-checklist/${CARRIER}`,
      carrier.driverToken,
      await checklistBody(carrier),
    );

    expect(response.statusCode, response.body).toBe(201);
    expect(
      (
        await prisma.vehicleChecklist.findUniqueOrThrow({
          where: { id: response.json().id },
        })
      ).branchId,
    ).toBe(carrier.branchId);
  });

  it("releases, with the driver's active branch to fall back on", async () => {
    const response = await release(carrier, routeId);

    expect(response.statusCode, response.body).toBe(200);
  });

  describe("with no active branch left to fall back on", () => {
    let stranded = "";

    beforeAll(async () => {
      // No driver branch, and two active ones in the company: the checklist
      // would skip the inactive branch and find nothing after it.
      await prisma.driver.update({
        where: { id: carrier.driverId },
        data: { branchId: null },
      });

      stranded = await plannedRoute(carrier, shipperId);
    });

    it("is refused at the release with 409 ROUTE_BRANCH_REQUIRED naming the branch and the plate, and stays planned", async () => {
      const response = await release(carrier, stranded);

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({
        code: "ROUTE_BRANCH_REQUIRED",
        message:
          `O checklist desta empresa exige filial ativa: a filial ${inactiveName} ` +
          `do veículo ${plate} está inativa. Reative a filial ou troque a filial do veículo.`,
      });
      expect(
        (await prisma.route.findUniqueOrThrow({ where: { id: stranded } }))
          .status,
      ).toBe("PLANNED");
    });

    it("releases once the branch is active again", async () => {
      await prisma.branch.update({
        where: { id: inactiveBranch },
        data: { is_active: true },
      });

      const response = await release(carrier, stranded);

      expect(response.statusCode, response.body).toBe(200);
    });
  });
});

describe("a company that does not ask for the checklist", () => {
  it("releases a route whatever the branches", async () => {
    // Two active branches and a crew without one: nothing to file, nothing
    // asked.
    await extraBranch(other, 3);

    const routeId = await plannedRoute(other, otherShipperId);
    const response = await release(other, routeId);

    expect(response.statusCode, response.body).toBe(200);
  });
});
