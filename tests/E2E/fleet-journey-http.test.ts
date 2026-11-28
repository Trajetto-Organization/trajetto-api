import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";
import { createPrismaClient } from "@/shared/database/database-client";
import { businessDateKey, dateOnlyFromKey } from "@/shared/time/business-day";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { readNdjson, seedUser } from "./support/fleet-maint-seed";

/**
 * The fleet, end to end (plan of 02/11/2026, M9; scenario S19), over real
 * HTTP, the outbox, the notification pipeline and Postgres:
 *
 *   vehicle with a responsible person (F1) → the driver's failed checklist on
 *   the route (C4/F2) → the alert to that person, with the suggested service
 *   order (F4) → the order, by a profile that only has the fleet → the
 *   refuelling made from the route (C5) → a fine → the bills to pay.
 *
 * Each record shows on the vehicle and, when it has one, on the route
 * (get-route `checklists`/`fuels`, F3); the fleet-only profile is refused
 * the deliveries' screens and the driver the office's writes; another
 * company sees none of it (404 like a missing record).
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let uploads: UploadService;
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const CARRIER = "018fead0-0000-7000-8000-00000000000a";
const OTHER = "018fead0-0000-7000-8000-00000000000b";

let carrier: FleetDriverSeed;
let other: FleetDriverSeed;

/** The fleet manager: a profile with the fleet's screens and nothing else. */
let fleet: { id: string; token: string };
let routeId = "";
let violationCodeId = "";

const storedKeys: string[] = [];

/** What the journey wrote, step by step. */
const journey = {
  checklistId: "",
  serviceOrderId: "",
  fuelId: "",
  fineId: "",
  orderBillId: "",
  fineBillId: "",
};

let mileage = 1_000;

async function storedPhoto(
  folder: "odometerPhotos" | "checklistPhotos",
): Promise<string> {
  const key = `${folder}/${CARRIER}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

function call(
  method: "GET" | "POST" | "PATCH",
  url: string,
  token: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload && { payload }),
  });
}

async function failedChecklistBody() {
  const photos = await Promise.all(
    [
      "current_mileage",
      "fuel_level_adequate",
      "tires_condition",
      "brakes_working",
    ].map(async (fieldName) => ({
      key: await storedPhoto("checklistPhotos"),
      fieldName,
    })),
  );

  mileage += 10;

  return {
    client_submission_id: randomUUID(),
    vehicleId: carrier.vehicleId,
    branchId: carrier.branchId,
    driverId: carrier.driverId,
    routeId,
    phase: "ROUTE_START",
    checklist_date: new Date(Date.now() - 60_000).toISOString(),
    current_mileage: mileage,
    created_from: "MOBILE_APP",
    headlights_working: true,
    taillights_working: true,
    turn_signals_working: true,
    seatbelts_working: true,
    dashboard_working: true,
    // The defect: the brakes.
    brakes_working: false,
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
    overall_condition: "rejected",
    photos,
  };
}

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "77888999000101",
    mileage,
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "77888999000202",
    mileage,
  });

  // The fleet's screens, and none of the deliveries'.
  const profile = await prisma.profileAccess.create({
    data: {
      name: "Só Frota",
      businessId: CARRIER,
      permissions: {
        create: [
          "vehicle_manage",
          "vehicle_checklist_manage",
          "service_order_manage",
          "fuel_manage",
          "fine_manage",
          "account_payable_manage",
        ].map((key) => ({
          permissionKey: key,
          action: key,
          canRead: true,
          canWrite: true,
          businessId: CARRIER,
        })),
      },
    },
  });

  fleet = await seedUser(
    prisma,
    "Fernanda da Frota",
    "BUSINESS_USER",
    CARRIER,
    {
      profileAccessId: profile.id,
    },
  );

  // The driver's released route with the truck.
  routeId = (
    await prisma.route.create({
      data: {
        code: 1,
        businessId: CARRIER,
        driverId: carrier.driverId,
        vehicleId: carrier.vehicleId,
        status: "RELEASED",
        scheduled_date: dateOnlyFromKey(
          businessDateKey(new Date(), "America/Sao_Paulo"),
        ),
        released_at: new Date(),
      },
      select: { id: true },
    })
  ).id;

  violationCodeId = (
    await prisma.trafficViolationCode.create({
      data: {
        code: `J${randomUUID().slice(0, 6)}`,
        sub_code: 0,
        description: "Transitar em velocidade superior à máxima permitida",
        legal_basis: "CTB",
        violator_type: "Condutor",
        gravity: "MEDIUM",
        gravity_raw: "Média",
        points: 4,
        competent_agency: "Estadual",
      },
    })
  ).id;

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");

  const pipelineModule =
    await import("@/shared/notifications/notification-pipeline-service");

  pipeline = pipelineModule.NotificationPipelineService.getInstance();
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the fleet journey (S19)", () => {
  it("1. the vehicle names who answers for it (F1)", async () => {
    const set = await call(
      "PATCH",
      `/vehicle/update-vehicle/${carrier.vehicleId}/business/${CARRIER}`,
      carrier.managerToken,
      { responsibleUserId: fleet.id },
    );

    expect(set.statusCode, set.body).toBe(200);

    // The fleet profile reads it, with the names the forms show (F1, F4).
    const vehicle = await call(
      "GET",
      `/vehicle/get-vehicle/${carrier.vehicleId}/business/${CARRIER}`,
      fleet.token,
    );

    expect(vehicle.statusCode, vehicle.body).toBe(200);
    expect(vehicle.json()).toMatchObject({
      responsibleUserId: fleet.id,
      responsibleUser: { name: "Fernanda da Frota" },
      branchId: carrier.branchId,
    });
  });

  it("2. the driver's failed checklist on the route alerts that person with the suggested order (F2, F4)", async () => {
    const checklist = await call(
      "POST",
      `/vehicle-checklist/create-vehicle-checklist/${CARRIER}`,
      carrier.driverToken,
      await failedChecklistBody(),
    );

    expect(checklist.statusCode, checklist.body).toBe(201);
    journey.checklistId = checklist.json().id;

    await pipeline.runOutboxCycle();
    await pipeline.runDeliveryCycle("internal");

    const alerts = await prisma.notification.findMany({
      where: {
        entityId: journey.checklistId,
        type: "vehicle-checklist-defect",
      },
    });

    // The responsible person alone, not the admins.
    expect(alerts.map((alert) => alert.userId)).toEqual([fleet.id]);

    const link = new URL(alerts[0].link!);

    expect(link.pathname).toBe("/dashboard/service-order");
    expect(Object.fromEntries(link.searchParams)).toMatchObject({
      new: "1",
      vehicleId: carrier.vehicleId,
      checklistId: journey.checklistId,
      description: expect.stringContaining("Freios"),
    });
  });

  it("3. the fleet profile opens the suggested service order", async () => {
    const vehicle = await prisma.vehicle.findUniqueOrThrow({
      where: { id: carrier.vehicleId },
    });

    const order = await call(
      "POST",
      `/service-order/create-service-order/${CARRIER}`,
      fleet.token,
      {
        date: new Date().toISOString(),
        maintenance_type: "EXTERNAL",
        description: "Checklist com defeito: Freios. Situação: Reprovado.",
        total_amount: 350,
        current_mileage_at_service: vehicle.current_mileage,
        maintenance_interval_km_at_service: 10_000,
        last_maintenance_mileage_at_service: 500,
        vehicleId: carrier.vehicleId,
        responsibleUserId: fleet.id,
        branchId: carrier.branchId,
        created_from: "WEB_DASHBOARD",
      },
    );

    expect(order.statusCode, order.body).toBe(201);

    const created = await prisma.serviceOrder.findFirstOrThrow({
      where: { businessId: CARRIER, vehicleId: carrier.vehicleId },
      orderBy: { created_at: "desc" },
    });

    journey.serviceOrderId = created.id;

    // On the vehicle's history.
    const history = await readNdjson<{ id: string }>(
      app,
      `/service-order/search-service-order-by-vehicle/${carrier.vehicleId}`,
      fleet.token,
    );

    expect(history.status, history.body).toBe(200);
    expect(history.rows.map((row) => row.id)).toContain(journey.serviceOrderId);
  });

  it("4. the driver refuels from the route (C5)", async () => {
    mileage += 10;

    const fuel = await call(
      "POST",
      `/fuel/create-fuel/${CARRIER}`,
      carrier.driverToken,
      {
        client_submission_id: randomUUID(),
        current_mileage: mileage,
        liters_amount: 50,
        price_per_liter: 6.5,
        total_amount: 325,
        refueling_date: new Date(Date.now() - 60_000).toISOString(),
        vehicleId: carrier.vehicleId,
        driverId: carrier.driverId,
        fuelTypeId: carrier.fuelTypeId,
        branchId: carrier.branchId,
        routeId,
        latitude: -23.55,
        longitude: -46.63,
        created_from: "MOBILE_APP",
        photo: { key: await storedPhoto("odometerPhotos") },
      },
    );

    expect(fuel.statusCode, fuel.body).toBe(201);

    journey.fuelId = (
      await prisma.fuel.findFirstOrThrow({
        where: { businessId: CARRIER, routeId },
        orderBy: { created_at: "desc" },
      })
    ).id;

    const history = await readNdjson<{ id: string }>(
      app,
      `/fuel/search-fuel-by-vehicle/${carrier.vehicleId}`,
      fleet.token,
    );

    expect(history.status, history.body).toBe(200);
    expect(history.rows.map((row) => row.id)).toContain(journey.fuelId);
  });

  it("5. the route shows its checklist and its refuelling (F3)", async () => {
    const route = await call(
      "GET",
      `/route/get-route/${routeId}/business/${CARRIER}`,
      carrier.managerToken,
    );

    expect(route.statusCode, route.body).toBe(200);

    const { checklists, fuels } = route.json().data;

    expect(checklists.route_start).toMatchObject({
      id: journey.checklistId,
      overall_condition: "rejected",
    });
    expect(fuels.map((fuel: { id: string }) => fuel.id)).toEqual([
      journey.fuelId,
    ]);
  });

  it("6. a fine for the vehicle and its driver", async () => {
    const fine = await call(
      "POST",
      `/fines/create-fine/${CARRIER}`,
      fleet.token,
      {
        violation_date: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        due_date: new Date(Date.now() + 27 * 86_400_000).toISOString(),
        amount: "293,47",
        points: "4",
        branchId: carrier.branchId,
        driverId: carrier.driverId,
        vehicleId: carrier.vehicleId,
        trafficViolationCodeId: violationCodeId,
        created_from: "WEB_DASHBOARD",
      },
    );

    expect(fine.statusCode, fine.body).toBe(201);

    journey.fineId = (
      await prisma.fine.findFirstOrThrow({
        where: { businessId: CARRIER, vehicleId: carrier.vehicleId },
      })
    ).id;

    const fines = await readNdjson<{ id: string }>(
      app,
      "/fines/list-fine?page=1&pageSize=50",
      fleet.token,
    );

    expect(fines.status, fines.body).toBe(200);
    expect(fines.rows.map((row) => row.id)).toEqual([journey.fineId]);
  });

  it("7. the bills to pay: the order's and the fine's", async () => {
    const bill = (extra: Record<string, unknown>) =>
      call(
        "POST",
        `/account-payable/create-account-payable/${CARRIER}`,
        fleet.token,
        {
          due_date: "2026-11-30",
          branchId: carrier.branchId,
          registrationUserId: fleet.id,
          vehicleId: carrier.vehicleId,
          ...extra,
        },
      );

    const forOrder = await bill({
      category: "MAINTENANCE",
      amount: 350,
      payee_name: "Oficina do Freio",
      serviceOrderId: journey.serviceOrderId,
      document_number: "NF 1001",
    });
    const forFine = await bill({
      category: "FINES",
      amount: 293.47,
      payee_name: "DETRAN-SP",
      document_number: "AIT 7455",
    });

    expect(forOrder.statusCode, forOrder.body).toBe(201);
    expect(forFine.statusCode, forFine.body).toBe(201);

    journey.orderBillId = forOrder.json().id;
    journey.fineBillId = forFine.json().id;

    expect(
      await prisma.accountPayable.findUniqueOrThrow({
        where: { id: journey.orderBillId },
      }),
    ).toMatchObject({
      serviceOrderId: journey.serviceOrderId,
      vehicleId: carrier.vehicleId,
    });

    const bills = await readNdjson<{ id: string }>(
      app,
      "/account-payable/list-account-payable?page=1&pageSize=50",
      fleet.token,
    );

    expect(bills.status, bills.body).toBe(200);
    expect(bills.rows.map((row) => row.id).sort()).toEqual(
      [journey.orderBillId, journey.fineBillId].sort(),
    );
  });
});

describe("permissions along the journey", () => {
  it("refuses the fleet-only profile the deliveries' screens", async () => {
    const routes = await call(
      "GET",
      "/route/list-routes?page=1&pageSize=10",
      fleet.token,
    );

    expect(routes.statusCode, routes.body).toBe(403);
    expect(routes.json().code).toBe("PERMISSION_DENIED");
  });

  it("refuses the driver the office's service order", async () => {
    const order = await call(
      "POST",
      `/service-order/create-service-order/${CARRIER}`,
      carrier.driverToken,
      {
        date: new Date().toISOString(),
        maintenance_type: "EXTERNAL",
        total_amount: 1,
        current_mileage_at_service: mileage,
        maintenance_interval_km_at_service: 10_000,
        last_maintenance_mileage_at_service: 500,
        vehicleId: carrier.vehicleId,
        responsibleUserId: fleet.id,
        branchId: carrier.branchId,
        created_from: "WEB_DASHBOARD",
      },
    );

    expect(order.statusCode, order.body).toBe(403);
  });
});

describe("another company", () => {
  it("finds none of the journey's records", async () => {
    const vehicle = await call(
      "GET",
      `/vehicle/get-vehicle/${carrier.vehicleId}/business/${OTHER}`,
      other.managerToken,
    );
    const route = await call(
      "GET",
      `/route/get-route/${routeId}/business/${OTHER}`,
      other.managerToken,
    );

    expect(vehicle.statusCode).toBe(404);
    expect(route.statusCode).toBe(404);

    // Not even through its own lists.
    const [orders, fines, bills] = await Promise.all([
      readNdjson<{ id: string }>(
        app,
        "/service-order/list-service-order?page=1&pageSize=50",
        other.managerToken,
      ),
      readNdjson<{ id: string }>(
        app,
        "/fines/list-fine?page=1&pageSize=50",
        other.managerToken,
      ),
      readNdjson<{ id: string }>(
        app,
        "/account-payable/list-account-payable?page=1&pageSize=50",
        other.managerToken,
      ),
    ]);

    expect(orders.status, orders.body).toBe(200);
    expect(fines.status, fines.body).toBe(200);
    expect(bills.status, bills.body).toBe(200);

    const seen = [...orders.rows, ...fines.rows, ...bills.rows].map(
      (row) => row.id,
    );

    for (const id of Object.values(journey)) {
      expect(seen).not.toContain(id);
    }
  });

  it("cannot open a service order on this company's vehicle", async () => {
    const order = await call(
      "POST",
      `/service-order/create-service-order/${OTHER}`,
      other.managerToken,
      {
        date: new Date().toISOString(),
        maintenance_type: "EXTERNAL",
        total_amount: 1,
        current_mileage_at_service: mileage,
        maintenance_interval_km_at_service: 10_000,
        last_maintenance_mileage_at_service: 500,
        vehicleId: carrier.vehicleId,
        responsibleUserId: other.driverUserId,
        branchId: other.branchId,
        created_from: "WEB_DASHBOARD",
      },
    );

    expect(order.statusCode, order.body).toBe(400);
    expect(order.json().code).toBe("VEHICLE_NOT_FOUND");
  });
});
