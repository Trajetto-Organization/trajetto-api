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
 * A driver's route records after the release, when the branches change
 * under them (wave 3.7), over real HTTP and Postgres.
 *
 * The release checks that the route's checklist can be filed
 * (ROUTE_BRANCH_REQUIRED), but nothing stops an admin from switching the
 * vehicle's branch off, or opening a second branch, afterwards. The driver's
 * departure checklist was then refused with BRANCH_INACTIVE or
 * BRANCH_REQUIRED and sat refused in the app's queue, with nobody in the
 * office knowing. Now:
 *
 * - a driver's record resolves through ACTIVE branches only: the vehicle's
 *   switched off falls through to the driver's, then to the company's single
 *   active one, and the record is filed;
 * - when nothing active resolves the refusal stays (409 BRANCH_REQUIRED) and
 *   the people who run the deliveries are told — one outbox event per route
 *   and phase, however often or concurrently the app retries;
 * - once the branch is fixed, the same checklist goes through.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let uploads: UploadService;
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;
const storedKeys: string[] = [];

const CARRIER = "018fb700-0000-7000-8000-00000000000a";
const OTHER = "018fb700-0000-7000-8000-00000000000b";

let carrier: FleetDriverSeed;
let other: FleetDriverSeed;
let shipperId = "";
let plate = "";
let mileage = 1_000;

const today = () => businessDateKey(new Date(), "America/Sao_Paulo");

const post = (url: string, token: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
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

async function checklistBody(
  seed: FleetDriverSeed,
  routeId: string,
  phase: "ROUTE_START" | "ROUTE_END" = "ROUTE_START",
) {
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
    routeId,
    phase,
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

async function fuelBody(seed: FleetDriverSeed, routeId: string) {
  const key = await storedPhoto(seed.businessId, "odometerPhotos");

  mileage += 10;

  return {
    client_submission_id: randomUUID(),
    routeId,
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

const postChecklist = async (
  seed: FleetDriverSeed,
  body: Record<string, unknown>,
) =>
  post(
    `/vehicle-checklist/create-vehicle-checklist/${seed.businessId}`,
    seed.driverToken,
    body,
  );

async function newBranch(seed: FleetDriverSeed, n: number): Promise<string> {
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

const setActive = (branchId: string, is_active: boolean) =>
  prisma.branch.update({ where: { id: branchId }, data: { is_active } });

/** A route with one stop, created and released through the API. */
async function releasedRoute(seed: FleetDriverSeed): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: `Cliente ${randomUUID().slice(0, 6)}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: seed.businessId,
      shipperId,
    },
    select: { id: true },
  });

  const created = await post(
    `/route/create-route/${seed.businessId}`,
    seed.managerToken,
    {
      driverId: seed.driverId,
      vehicleId: seed.vehicleId,
      scheduled_date: today(),
      deliveryIds: [delivery.id],
    },
  );

  expect(created.statusCode, created.body).toBe(201);

  const routeId = created.json().data.id as string;

  const released = await app.inject({
    method: "PATCH",
    url: `/route/release-route/${routeId}/business/${seed.businessId}`,
    headers: { authorization: `Bearer ${seed.managerToken}` },
    payload: { released: true },
  });

  expect(released.statusCode, released.body).toBe(200);

  return routeId;
}

const noticeKey = (routeId: string, slot: string) =>
  `route.record_branch_missing:${routeId}:${slot}`;

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "72888999000101",
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "72888999000202",
  });

  // CARRIER asks for both route checklists.
  await prisma.businessSettings.create({
    data: { businessId: CARRIER, checklist_requirement: "ROUTE_START_AND_END" },
  });

  plate = (
    await prisma.vehicle.findUniqueOrThrow({
      where: { id: carrier.vehicleId },
      select: { license_plate: true },
    })
  ).license_plate;

  shipperId = (
    await prisma.shipper.create({
      data: { name: "Embarcador", businessId: CARRIER },
      select: { id: true },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");

  pipeline = (
    await import("@/shared/notifications/notification-pipeline-service")
  ).NotificationPipelineService.getInstance();
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the vehicle's branch switched off after the release", () => {
  let routeId = "";
  let vehicleBranch = "";

  beforeAll(async () => {
    // The truck is filed under a branch of its own; the driver under the
    // seed's. Both active at the release.
    vehicleBranch = await newBranch(carrier, 1);
    await prisma.vehicle.update({
      where: { id: carrier.vehicleId },
      data: { branchId: vehicleBranch },
    });

    routeId = await releasedRoute(carrier);

    // An admin switches the truck's branch off with the route on the street.
    await setActive(vehicleBranch, false);
  });

  it("files the departure checklist under the driver's active branch", async () => {
    const response = await postChecklist(
      carrier,
      await checklistBody(carrier, routeId),
    );

    expect(response.statusCode, response.body).toBe(201);

    const row = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: response.json().id },
    });
    expect(row).toMatchObject({
      branchId: carrier.branchId,
      routeId,
      phase: "ROUTE_START",
    });
  });

  it("files the route's refuelling the same way", async () => {
    const response = await post(
      `/fuel/create-fuel/${CARRIER}`,
      carrier.driverToken,
      await fuelBody(carrier, routeId),
    );

    expect(response.statusCode, response.body).toBe(201);

    const row = await prisma.fuel.findUniqueOrThrow({
      where: { id: response.json().id },
    });
    expect(row).toMatchObject({ branchId: carrier.branchId, routeId });
  });

  // The app's form sends the branch it read from the vehicle (use-checklist
  // and use-fuel, the installed build and the current one alike): the
  // switched-off one. The branch gate in front of the use case refused it
  // with 403 BRANCH_INACTIVE, so the fallback above never ran for the app.
  it("files them the same way when the app's body names the vehicle's switched-off branch", async () => {
    const checklist = await postChecklist(carrier, {
      ...(await checklistBody(carrier, routeId)),
      branchId: vehicleBranch,
    });

    expect(checklist.statusCode, checklist.body).toBe(201);
    expect(
      (
        await prisma.vehicleChecklist.findUniqueOrThrow({
          where: { id: checklist.json().id },
        })
      ).branchId,
    ).toBe(carrier.branchId);

    const fuel = await post(
      `/fuel/create-fuel/${CARRIER}`,
      carrier.driverToken,
      {
        ...(await fuelBody(carrier, routeId)),
        branchId: vehicleBranch,
      },
    );

    expect(fuel.statusCode, fuel.body).toBe(201);
    expect(
      (await prisma.fuel.findUniqueOrThrow({ where: { id: fuel.json().id } }))
        .branchId,
    ).toBe(carrier.branchId);
  });

  it("never lets the driver's body pick a branch: another company's is ignored like any other", async () => {
    const response = await postChecklist(carrier, {
      ...(await checklistBody(carrier, routeId)),
      branchId: other.branchId,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(
      (
        await prisma.vehicleChecklist.findUniqueOrThrow({
          where: { id: response.json().id },
        })
      ).branchId,
    ).toBe(carrier.branchId);
  });

  it("files the arrival checklist under the company's single active branch when the driver has none", async () => {
    await prisma.driver.update({
      where: { id: carrier.driverId },
      data: { branchId: null },
    });

    const response = await postChecklist(
      carrier,
      await checklistBody(carrier, routeId, "ROUTE_END"),
    );

    expect(response.statusCode, response.body).toBe(201);
    expect(
      (
        await prisma.vehicleChecklist.findUniqueOrThrow({
          where: { id: response.json().id },
        })
      ).branchId,
    ).toBe(carrier.branchId);

    // Nobody was told anything: nothing was refused.
    expect(
      await prisma.domainOutboxEvent.count({
        where: { topic: "route.record_branch_missing" },
      }),
    ).toBe(0);
  });
});

describe("no active branch left to file the driver's record under", () => {
  let routeId = "";
  let vehicleBranch = "";
  let secondActive = "";
  // The app's queued departure checklist, refused below and resent once
  // the manager fixed the branch ("Tentar de novo").
  let appBody: Record<string, unknown> = {};

  beforeAll(async () => {
    // The driver has no branch (above); the truck's branch is active at the
    // release, then switched off, and a second active branch exists: no
    // single one to fall back on.
    vehicleBranch = await newBranch(carrier, 2);
    await prisma.vehicle.update({
      where: { id: carrier.vehicleId },
      data: { branchId: vehicleBranch },
    });

    routeId = await releasedRoute(carrier);

    secondActive = await newBranch(carrier, 3);
    await setActive(vehicleBranch, false);
  });

  it("refuses the departure checklist with 409 BRANCH_REQUIRED and tells the dispatcher once, whatever the retries", async () => {
    const first = await postChecklist(
      carrier,
      await checklistBody(carrier, routeId),
    );

    expect(first.statusCode, first.body).toBe(409);
    expect(first.json().code).toBe("BRANCH_REQUIRED");

    // The app's retries, one after another and then at once — as two
    // replicas would take them.
    const again = await postChecklist(
      carrier,
      await checklistBody(carrier, routeId),
    );
    const bodies = await Promise.all(
      [0, 1, 2].map(() => checklistBody(carrier, routeId)),
    );
    const together = await Promise.all(
      bodies.map((body) => postChecklist(carrier, body)),
    );

    for (const response of [again, ...together]) {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("BRANCH_REQUIRED");
    }

    const notices = await prisma.domainOutboxEvent.findMany({
      where: { topic: "route.record_branch_missing" },
    });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      eventKey: noticeKey(routeId, "ROUTE_START"),
      businessId: CARRIER,
      aggregateType: "route",
      aggregateId: routeId,
      actorId: carrier.driverUserId,
    });
    expect(notices[0].payload).toMatchObject({
      routeId,
      businessId: CARRIER,
      record: "CHECKLIST",
      phase: "ROUTE_START",
      vehiclePlate: plate,
      driverName: "Motorista da Frota",
    });

    // Nothing was written for the refused checklist.
    expect(
      await prisma.vehicleChecklist.count({
        where: { routeId, phase: "ROUTE_START" },
      }),
    ).toBe(0);
  });

  it("answers the app's body, which names the switched-off branch, the same way: 409 and no second notice", async () => {
    appBody = {
      ...(await checklistBody(carrier, routeId)),
      branchId: vehicleBranch,
    };

    // The app's queue resends the same item (same submission id).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await postChecklist(carrier, appBody);

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("BRANCH_REQUIRED");
    }

    expect(
      await prisma.domainOutboxEvent.count({
        where: { topic: "route.record_branch_missing" },
      }),
    ).toBe(1);
  });

  it("reaches the manager's inbox and the route's trail, once", async () => {
    await pipeline.runOutboxCycle();
    await pipeline.runDeliveryCycle("internal");

    const inbox = await prisma.notification.findMany({
      where: { businessId: CARRIER, entityId: routeId },
    });

    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      title: "Checklist do motorista recusado",
      message: expect.stringContaining(
        `Checklist de saída do motorista Motorista da Frota recusado: a rota`,
      ),
    });
    expect(inbox[0].message).toContain(`(veículo ${plate})`);
    expect(inbox[0].link).toContain(`/dashboard/routes/${routeId}`);

    const trail = await prisma.activity.findMany({
      where: { businessId: CARRIER, entityId: routeId, status: "Pendente" },
    });

    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      type: "Rota",
      performedBy: carrier.driverUserId,
    });

    // Another company's people hear nothing.
    expect(
      await prisma.notification.count({ where: { businessId: OTHER } }),
    ).toBe(0);
  });

  it("tells the dispatcher about the route's refuelling under its own key", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await post(
        `/fuel/create-fuel/${CARRIER}`,
        carrier.driverToken,
        await fuelBody(carrier, routeId),
      );

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("BRANCH_REQUIRED");
    }

    const notices = await prisma.domainOutboxEvent.findMany({
      where: { topic: "route.record_branch_missing" },
      orderBy: { created_at: "asc" },
    });

    expect(notices.map((notice) => notice.eventKey)).toEqual([
      noticeKey(routeId, "ROUTE_START"),
      noticeKey(routeId, "FUEL"),
    ]);
  });

  it("files the same checklist once the manager fixes the branch", async () => {
    // Switching the second branch off leaves the company a single active
    // one: the record falls back to it.
    await setActive(secondActive, false);

    const response = await postChecklist(
      carrier,
      await checklistBody(carrier, routeId),
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

  it("files the app's refused item when 'Tentar de novo' resends it, the same submission", async () => {
    const response = await postChecklist(carrier, appBody);

    expect(response.statusCode, response.body).toBe(201);
    expect(
      await prisma.vehicleChecklist.findUniqueOrThrow({
        where: { id: response.json().id },
      }),
    ).toMatchObject({
      branchId: carrier.branchId,
      client_submission_id: appBody.client_submission_id,
    });
  });
});
