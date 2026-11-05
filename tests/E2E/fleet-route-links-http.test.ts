import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";
import type { RouteStopStatus } from "@/shared/route/route-rules";
import { createPrismaClient } from "@/shared/database/database-client";
import { businessDateKey, dateOnlyFromKey } from "@/shared/time/business-day";

import {
  fakeJpeg,
  seedFleetDriver,
  seedUser,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";

/**
 * Checklists and refuellings tied to the route, and the vehicle's
 * responsible person, over real HTTP and Postgres (plan of 02/11/2026: C4,
 * C5, F1, F3 write side, K6, and decision D10).
 *
 * - A checklist names its route and moment (departure or arrival), a
 *   refuelling its route; the route must be the driver's, with the record's
 *   vehicle. Another driver's route, another vehicle, or a route without a
 *   vehicle is 422 ROUTE_LINK_MISMATCH; another company's route reads like a
 *   missing one (404 DELIVERY_ROUTE_NOT_FOUND, never the router's ROUTE_NOT_FOUND).
 *   The link never asks the route's status. A driver's arrival checklist
 *   does, from an app build of contract 5 on: it waits for the route to have
 *   left and every stop to be resolved (409 CHECKLIST_ARRIVAL_ROUTE_OPEN);
 *   an older build's is recorded and flagged in the trail.
 * - A checklist or a refuelling the app queued offline carries the tap
 *   (occurred_at) and the send stamp (X-Client-Sent-At): the stored date is
 *   the tap on the server's clock, whatever the phone's clock said.
 * - A released route keeps its vehicle (D10): the checklist the app holds
 *   "Iniciar rota" for is about that vehicle.
 * - The vehicle's responsible person is a user of the same company; anyone
 *   else answers like a user that does not exist.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let uploads: UploadService;
const storedKeys: string[] = [];

const CARRIER = "018feaa0-0000-7000-8000-00000000000a";
const OTHER = "018feaa0-0000-7000-8000-00000000000b";

let carrier: FleetDriverSeed;
let other: FleetDriverSeed;

let colleagueDriverId = "";
let secondVehicleId = "";

let releasedRoute = "";
let colleagueRoute = "";
let otherVehicleRoute = "";
let noVehicleRoute = "";
let foreignRoute = "";

let routeCode = 900;

async function seedRoute(
  seed: { businessId: string },
  driverId: string,
  vehicleId: string | null,
  status: "PLANNED" | "RELEASED" | "IN_PROGRESS" = "RELEASED",
): Promise<string> {
  routeCode += 1;

  const route = await prisma.route.create({
    data: {
      code: routeCode,
      businessId: seed.businessId,
      driverId,
      vehicleId,
      status,
      scheduled_date: dateOnlyFromKey(
        businessDateKey(new Date(), "America/Sao_Paulo"),
      ),
      released_at: status === "PLANNED" ? null : new Date(),
    },
    select: { id: true },
  });

  return route.id;
}

async function storedPhoto(
  businessId: string,
  folder: "odometerPhotos" | "checklistPhotos",
): Promise<string> {
  const key = `${folder}/${businessId}/${Date.now()}-test-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

let mileage = 1_000;

async function checklistBody(
  seed: FleetDriverSeed,
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

  mileage += 10;

  return {
    client_submission_id: randomUUID(),
    vehicleId: seed.vehicleId,
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

async function fuelBody(
  seed: FleetDriverSeed,
  extra: Record<string, unknown> = {},
) {
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
    branchId: seed.branchId,
    latitude: -23.55,
    longitude: -46.63,
    created_from: "MOBILE_APP",
    photo: { key },
    ...extra,
  };
}

const post = (
  url: string,
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload: body,
  });

const checklistUrl = `/vehicle-checklist/create-vehicle-checklist/${CARRIER}`;
const fuelUrl = `/fuel/create-fuel/${CARRIER}`;

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "66777888000101",
    mileage: 1_000,
  });
  other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "66777888000202",
    mileage: 1_000,
  });

  const colleague = await prisma.driver.create({
    data: {
      name: "Colega",
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
      businessId: CARRIER,
      branchId: carrier.branchId,
    },
  });
  colleagueDriverId = colleague.id;

  const truck = await prisma.vehicle.findUniqueOrThrow({
    where: { id: carrier.vehicleId },
  });
  const {
    id: _id,
    created_at: _created,
    updated_at: _updated,
    driverId: _driver,
    responsibleUserId: _responsible,
    ...copy
  } = truck;

  secondVehicleId = (
    await prisma.vehicle.create({
      data: {
        ...copy,
        license_plate: randomUUID().slice(0, 7).toUpperCase(),
        renavam: randomUUID().slice(0, 11),
      },
      select: { id: true },
    })
  ).id;

  releasedRoute = await seedRoute(carrier, carrier.driverId, carrier.vehicleId);
  colleagueRoute = await seedRoute(carrier, colleagueDriverId, secondVehicleId);
  otherVehicleRoute = await seedRoute(
    carrier,
    carrier.driverId,
    secondVehicleId,
    "PLANNED",
  );
  noVehicleRoute = await seedRoute(carrier, carrier.driverId, null, "PLANNED");
  foreignRoute = await seedRoute(other, other.driverId, other.vehicleId);

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));
  await app?.close();
  await prisma.$disconnect();
});

describe("a checklist made for the route (C4, F3)", () => {
  it("is recorded with its route and moment", async () => {
    const response = await post(
      checklistUrl,
      carrier.driverToken,
      await checklistBody(carrier, {
        routeId: releasedRoute,
        phase: "ROUTE_START",
      }),
    );

    expect(response.statusCode).toBe(201);

    const row = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: response.json().id },
    });

    expect(row).toMatchObject({ routeId: releasedRoute, phase: "ROUTE_START" });
  });

  it("keeps a checklist without a route standalone", async () => {
    const response = await post(
      checklistUrl,
      carrier.driverToken,
      await checklistBody(carrier),
    );

    expect(response.statusCode).toBe(201);

    const row = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: response.json().id },
    });

    expect(row).toMatchObject({ routeId: null, phase: "STANDALONE" });
  });

  it("refuses another driver's route, another vehicle and a route without one", async () => {
    for (const routeId of [colleagueRoute, otherVehicleRoute, noVehicleRoute]) {
      const response = await post(
        checklistUrl,
        carrier.driverToken,
        await checklistBody(carrier, { routeId, phase: "ROUTE_START" }),
      );

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ROUTE_LINK_MISMATCH");
    }
  });

  it("answers another company's route like a missing one", async () => {
    const answers = [];

    for (const routeId of [foreignRoute, randomUUID()]) {
      const response = await post(
        checklistUrl,
        carrier.driverToken,
        await checklistBody(carrier, { routeId, phase: "ROUTE_END" }),
      );

      answers.push({
        status: response.statusCode,
        code: response.json().code,
        message: response.json().message,
      });
    }

    expect(answers[0]).toMatchObject({
      status: 404,
      code: "DELIVERY_ROUTE_NOT_FOUND",
    });
    expect(answers[1]).toEqual(answers[0]);
  });

  it("refuses a route without the moment", async () => {
    const response = await post(
      checklistUrl,
      carrier.driverToken,
      await checklistBody(carrier, { routeId: releasedRoute }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("CHECKLIST_ROUTE_PHASE_REQUIRED");
  });

  it("dates a checklist queued offline by the tap, on the server's clock (K6)", async () => {
    // The phone's clock runs two hours ahead; the inspection was ten
    // minutes before the send.
    const ahead = 2 * 60 * 60 * 1000;
    const sentAt = new Date(Date.now() + ahead);
    const tappedAt = new Date(sentAt.getTime() - 10 * 60 * 1000);

    const response = await post(
      checklistUrl,
      carrier.driverToken,
      await checklistBody(carrier, {
        checklist_date: tappedAt.toISOString(),
        occurred_at: tappedAt.toISOString(),
      }),
      { "x-client-sent-at": sentAt.toISOString() },
    );

    expect(response.statusCode).toBe(201);

    const row = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: response.json().id },
    });
    const expected = Date.now() - 10 * 60 * 1000;

    expect(
      Math.abs(new Date(row.checklist_date).getTime() - expected),
    ).toBeLessThan(60 * 1000);
  });
});

describe("a checklist with a defect (F2)", () => {
  it("alerts the fleet in the checklist's own commit, and a clean one alerts nobody", async () => {
    const clean = await post(
      checklistUrl,
      carrier.driverToken,
      await checklistBody(carrier),
    );
    const failed = await post(
      checklistUrl,
      carrier.driverToken,
      await checklistBody(carrier, {
        brakes_working: false,
        overall_condition: "rejected",
        photos: [
          ...(await checklistBody(carrier)).photos,
          {
            key: await storedPhoto(carrier.businessId, "checklistPhotos"),
            fieldName: "brakes_working",
          },
        ],
      }),
    );

    expect(clean.statusCode).toBe(201);
    expect(failed.statusCode).toBe(201);

    const alerts = await prisma.domainOutboxEvent.findMany({
      where: {
        topic: "vehicle-checklist.defects_found",
        aggregateId: { in: [clean.json().id, failed.json().id] },
      },
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      aggregateId: failed.json().id,
      businessId: CARRIER,
    });
    expect(alerts[0].payload).toMatchObject({
      vehicleId: carrier.vehicleId,
      defects: ["Freios"],
      verdict: "Reprovado",
    });
  });
});

describe("a refuelling made from the route (C5, F3)", () => {
  it("is recorded with its route", async () => {
    const response = await post(
      fuelUrl,
      carrier.driverToken,
      await fuelBody(carrier, { routeId: releasedRoute }),
    );

    expect(response.statusCode).toBe(201);

    const row = await prisma.fuel.findUniqueOrThrow({
      where: { id: response.json().id },
    });

    expect(row.routeId).toBe(releasedRoute);
  });

  it("refuses another driver's route and answers another company's like a missing one", async () => {
    const colleague = await post(
      fuelUrl,
      carrier.driverToken,
      await fuelBody(carrier, { routeId: colleagueRoute }),
    );

    expect(colleague.statusCode).toBe(422);
    expect(colleague.json().code).toBe("ROUTE_LINK_MISMATCH");

    const foreign = await post(
      fuelUrl,
      carrier.driverToken,
      await fuelBody(carrier, { routeId: foreignRoute }),
    );

    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe("DELIVERY_ROUTE_NOT_FOUND");
  });

  it("dates a refuelling queued offline by the tap, on the server's clock (K6)", async () => {
    const ahead = 2 * 60 * 60 * 1000;
    const sentAt = new Date(Date.now() + ahead);
    const tappedAt = new Date(sentAt.getTime() - 10 * 60 * 1000);

    const response = await post(
      fuelUrl,
      carrier.driverToken,
      await fuelBody(carrier, {
        refueling_date: tappedAt.toISOString(),
        occurred_at: tappedAt.toISOString(),
      }),
      { "x-client-sent-at": sentAt.toISOString() },
    );

    expect(response.statusCode).toBe(201);

    const row = await prisma.fuel.findUniqueOrThrow({
      where: { id: response.json().id },
    });
    const expected = Date.now() - 10 * 60 * 1000;

    expect(
      Math.abs(new Date(row.refueling_date).getTime() - expected),
    ).toBeLessThan(60 * 1000);
  });
});

describe("a record a substitute driver makes for their route, after it ended (C4, C5)", () => {
  // The common company: the truck has no fixed driver (Vehicle.driverId),
  // the route hands it over. The arrival checklist opens once the last stop
  // is resolved — which is what closes the route — and a departure
  // checklist or a refuelling queued offline may land after the end too.
  // Custody ended with the route, but the route the record names is the
  // proof the driver had the truck: it must not answer 403.
  let substitute: { id: string; token: string };
  let thirdVehicleId = "";
  let endedRoute = "";

  beforeAll(async () => {
    substitute = await seedUser(
      prisma,
      CARRIER,
      "BUSINESS_USER",
      colleagueDriverId,
    );

    const truck = await prisma.vehicle.findUniqueOrThrow({
      where: { id: secondVehicleId },
    });
    const {
      id: _id,
      created_at: _created,
      updated_at: _updated,
      driverId: _driver,
      responsibleUserId: _responsible,
      ...copy
    } = truck;

    thirdVehicleId = (
      await prisma.vehicle.create({
        data: {
          ...copy,
          license_plate: randomUUID().slice(0, 7).toUpperCase(),
          renavam: randomUUID().slice(0, 11),
        },
        select: { id: true },
      })
    ).id;

    routeCode += 1;
    endedRoute = (
      await prisma.route.create({
        data: {
          code: routeCode,
          businessId: CARRIER,
          driverId: colleagueDriverId,
          vehicleId: thirdVehicleId,
          status: "COMPLETED",
          scheduled_date: dateOnlyFromKey(
            businessDateKey(new Date(), "America/Sao_Paulo"),
          ),
          released_at: new Date(Date.now() - 3 * 60 * 60 * 1000),
          started_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
          completed_at: new Date(Date.now() - 5 * 60 * 1000),
        },
        select: { id: true },
      })
    ).id;
  });

  it("records the arrival checklist of the route that just ended", async () => {
    const response = await post(
      checklistUrl,
      substitute.token,
      await checklistBody(carrier, {
        vehicleId: thirdVehicleId,
        driverId: colleagueDriverId,
        routeId: endedRoute,
        phase: "ROUTE_END",
      }),
    );

    expect(response.statusCode).toBe(201);

    const row = await prisma.vehicleChecklist.findUniqueOrThrow({
      where: { id: response.json().id },
    });

    expect(row).toMatchObject({
      routeId: endedRoute,
      phase: "ROUTE_END",
      vehicleId: thirdVehicleId,
      driverId: colleagueDriverId,
    });
  });

  it("records a refuelling made on that route", async () => {
    const response = await post(
      fuelUrl,
      substitute.token,
      await fuelBody(carrier, {
        vehicleId: thirdVehicleId,
        driverId: colleagueDriverId,
        routeId: endedRoute,
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(
      (
        await prisma.fuel.findUniqueOrThrow({
          where: { id: response.json().id },
        })
      ).routeId,
    ).toBe(endedRoute);
  });

  it("still refuses that truck without the route", async () => {
    const checklist = await post(
      checklistUrl,
      substitute.token,
      await checklistBody(carrier, {
        vehicleId: thirdVehicleId,
        driverId: colleagueDriverId,
      }),
    );
    const fuel = await post(
      fuelUrl,
      substitute.token,
      await fuelBody(carrier, {
        vehicleId: thirdVehicleId,
        driverId: colleagueDriverId,
      }),
    );

    expect(checklist.statusCode).toBe(403);
    expect(fuel.statusCode).toBe(403);
  });
});

describe("a route proves custody only for the span it handed the truck over", () => {
  // The route a record names stands in for the custody check only while it
  // handed the truck over, and only for a record made then (or within the
  // arrival window after its end). An old, cancelled or never released route
  // of the driver must not open today's truck — now with somebody else — to
  // a refuelling that moves its odometer or a checklist that alerts the
  // fleet. A record made during the route still lands however late it syncs.
  let former: { id: string; token: string };
  let formerDriverId = "";
  let truckId = "";

  async function endedRouteOf(
    vehicleId: string,
    data: {
      status: "COMPLETED" | "CANCELLED";
      released_at: Date | null;
      started_at: Date | null;
      completed_at: Date | null;
    },
  ): Promise<string> {
    routeCode += 1;

    return (
      await prisma.route.create({
        data: {
          code: routeCode,
          businessId: CARRIER,
          driverId: formerDriverId,
          vehicleId,
          scheduled_date: dateOnlyFromKey(
            businessDateKey(
              data.released_at ?? new Date(),
              "America/Sao_Paulo",
            ),
          ),
          ...data,
        },
        select: { id: true },
      })
    ).id;
  }

  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const ago = (ms: number) => new Date(Date.now() - ms);

  beforeAll(async () => {
    formerDriverId = (
      await prisma.driver.create({
        data: {
          name: "Motorista antigo",
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
          businessId: CARRIER,
          branchId: carrier.branchId,
        },
        select: { id: true },
      })
    ).id;

    former = await seedUser(prisma, CARRIER, "BUSINESS_USER", formerDriverId);
    truckId = await freeTruck();
  });

  /** Nobody's fixed truck: only a route can hand it to the former driver. */
  async function freeTruck(): Promise<string> {
    const truck = await prisma.vehicle.findUniqueOrThrow({
      where: { id: carrier.vehicleId },
    });
    const {
      id: _id,
      created_at: _created,
      updated_at: _updated,
      driverId: _driver,
      responsibleUserId: _responsible,
      ...copy
    } = truck;

    return (
      await prisma.vehicle.create({
        data: {
          ...copy,
          license_plate: randomUUID().slice(0, 7).toUpperCase(),
          renavam: randomUUID().slice(0, 11),
        },
        select: { id: true },
      })
    ).id;
  }

  const recordsOn = async (vehicleId: string, routeId: string, at: Date) => {
    const checklist = await post(
      checklistUrl,
      former.token,
      await checklistBody(carrier, {
        vehicleId,
        driverId: formerDriverId,
        routeId,
        phase: "ROUTE_END",
        checklist_date: at.toISOString(),
      }),
    );
    const fuel = await post(
      fuelUrl,
      former.token,
      await fuelBody(carrier, {
        vehicleId,
        driverId: formerDriverId,
        routeId,
        refueling_date: new Date(at.getTime() + 60_000).toISOString(),
      }),
    );

    return { checklist, fuel };
  };

  it("refuses a route cancelled before it was ever released", async () => {
    const routeId = await endedRouteOf(truckId, {
      status: "CANCELLED",
      released_at: null,
      started_at: null,
      completed_at: null,
    });

    const { checklist, fuel } = await recordsOn(
      truckId,
      routeId,
      ago(10 * 60 * 1000),
    );

    expect(checklist.statusCode, checklist.body).toBe(403);
    expect(checklist.json().code).toBe("VEHICLE_NOT_ASSIGNED_TO_DRIVER");
    expect(fuel.statusCode, fuel.body).toBe(403);
    expect(fuel.json().code).toBe("VEHICLE_NOT_ASSIGNED_TO_DRIVER");
  });

  it("refuses a record of today on a route that ended a month ago", async () => {
    const routeId = await endedRouteOf(truckId, {
      status: "COMPLETED",
      released_at: ago(30 * DAY + 3 * HOUR),
      started_at: ago(30 * DAY + 2 * HOUR),
      completed_at: ago(30 * DAY),
    });

    const { checklist, fuel } = await recordsOn(
      truckId,
      routeId,
      ago(10 * 60 * 1000),
    );

    expect(checklist.statusCode, checklist.body).toBe(403);
    expect(checklist.json().code).toBe("VEHICLE_NOT_ASSIGNED_TO_DRIVER");
    expect(fuel.statusCode, fuel.body).toBe(403);
    expect(fuel.json().code).toBe("VEHICLE_NOT_ASSIGNED_TO_DRIVER");
  });

  it("records what was made during the route, synced ten days later", async () => {
    // A truck of its own: its last readings are these two records.
    const lateTruckId = await freeTruck();
    const routeId = await endedRouteOf(lateTruckId, {
      status: "COMPLETED",
      released_at: ago(10 * DAY + 3 * HOUR),
      started_at: ago(10 * DAY + 2 * HOUR),
      completed_at: ago(10 * DAY),
    });

    const { checklist, fuel } = await recordsOn(
      lateTruckId,
      routeId,
      ago(10 * DAY + 90 * 60 * 1000),
    );

    expect(checklist.statusCode, checklist.body).toBe(201);
    expect(fuel.statusCode, fuel.body).toBe(201);
  });
});

describe("the arrival checklist waits for the route to be resolved (05/11/2026)", () => {
  // A driver's arrival (ROUTE_END) is made once the route left and EVERY
  // stop is final (COMPLETED, FAILED, CANCELLED), whatever their order and
  // however many the dispatcher added on the way. Refused, 409
  // CHECKLIST_ARRIVAL_ROUTE_OPEN, only for an app build of contract 5 on; an
  // older build — or mobile `main`, which sends no header — is recorded as
  // before and the trail says how many stops were still open. The office is
  // never asked, and a resend is answered with the record first.
  const CONTRACT_5 =
    "platform=android; version=1.5.0; build=50; runtime=e2e; update=embedded; contract=5; outbox=1";
  const CONTRACT_4 =
    "platform=android; version=1.4.0; build=40; runtime=e2e; update=embedded; contract=4; outbox=1";

  let shipperId = "";

  beforeAll(async () => {
    shipperId = (
      await prisma.shipper.create({
        data: { name: "Embarcador da chegada", businessId: CARRIER },
        select: { id: true },
      })
    ).id;
  });

  /** A truck of its own: one vehicle runs at most one route at a time. */
  async function truckOfItsOwn(): Promise<string> {
    const truck = await prisma.vehicle.findUniqueOrThrow({
      where: { id: carrier.vehicleId },
    });
    const {
      id: _id,
      created_at: _created,
      updated_at: _updated,
      driverId: _driver,
      responsibleUserId: _responsible,
      ...copy
    } = truck;

    return (
      await prisma.vehicle.create({
        data: {
          ...copy,
          license_plate: randomUUID().slice(0, 7).toUpperCase(),
          renavam: randomUUID().slice(0, 11),
        },
        select: { id: true },
      })
    ).id;
  }

  async function addStop(
    routeId: string,
    sequence: number,
    status: RouteStopStatus,
  ): Promise<string> {
    const delivery = await prisma.delivery.create({
      data: {
        businessId: CARRIER,
        shipperId,
        recipient_name: "Cliente",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        status: status === "PENDING" ? "PENDING" : "IN_TRANSIT",
        driverId: carrier.driverId,
      },
      select: { id: true },
    });

    return (
      await prisma.routeStop.create({
        data: { routeId, deliveryId: delivery.id, sequence, status },
        select: { id: true },
      })
    ).id;
  }

  /** The driver's running route, on a truck of its own, with these stops. */
  async function runningRoute(stops: RouteStopStatus[]) {
    const vehicleId = await truckOfItsOwn();

    routeCode += 1;

    const routeId = (
      await prisma.route.create({
        data: {
          code: routeCode,
          businessId: CARRIER,
          driverId: carrier.driverId,
          vehicleId,
          status: "IN_PROGRESS",
          scheduled_date: dateOnlyFromKey(
            businessDateKey(new Date(), "America/Sao_Paulo"),
          ),
          released_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
          started_at: new Date(Date.now() - 60 * 60 * 1000),
        },
        select: { id: true },
      })
    ).id;

    const stopIds: string[] = [];

    for (const [index, status] of stops.entries()) {
      stopIds.push(await addStop(routeId, (index + 1) * 10, status));
    }

    return { routeId, vehicleId, stopIds };
  }

  const arrival = async (
    token: string,
    route: { routeId: string; vehicleId: string },
    headers: Record<string, string> = {},
    extra: Record<string, unknown> = {},
  ) =>
    post(
      checklistUrl,
      token,
      await checklistBody(carrier, {
        vehicleId: route.vehicleId,
        driverId: carrier.driverId,
        routeId: route.routeId,
        phase: "ROUTE_END",
        ...extra,
      }),
      headers,
    );

  it("refuses a contract 5 build while stops are open, saying how many, and writes nothing", async () => {
    const route = await runningRoute(["COMPLETED", "PENDING", "ARRIVED"]);
    const key = randomUUID();

    const response = await arrival(
      carrier.driverToken,
      route,
      { "x-trajetto-client-version": CONTRACT_5 },
      { client_submission_id: key },
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(response.headers["x-error-code"]).toBe(
      "CHECKLIST_ARRIVAL_ROUTE_OPEN",
    );
    expect(response.json()).toEqual({
      code: "CHECKLIST_ARRIVAL_ROUTE_OPEN",
      message:
        "O checklist de chegada só pode ser feito depois que todas as entregas da rota forem resolvidas (faltam 2).",
      open_stops: 2,
    });
    expect(
      await prisma.vehicleChecklist.count({
        where: { client_submission_id: key },
      }),
    ).toBe(0);
  });

  it("records it once every stop is final, in any order", async () => {
    // The last stop of the list was the first to be resolved.
    const route = await runningRoute(["PENDING", "ARRIVED", "COMPLETED"]);

    await prisma.routeStop.update({
      where: { id: route.stopIds[0] },
      data: { status: "FAILED", completed_at: new Date() },
    });
    await prisma.routeStop.update({
      where: { id: route.stopIds[1] },
      data: { status: "CANCELLED" },
    });

    const response = await arrival(carrier.driverToken, route, {
      "x-trajetto-client-version": CONTRACT_5,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(
      await prisma.vehicleChecklist.findUniqueOrThrow({
        where: { id: response.json().id },
      }),
    ).toMatchObject({ routeId: route.routeId, phase: "ROUTE_END" });
  });

  it("refuses it again once the dispatcher adds a stop to the running route", async () => {
    const route = await runningRoute(["COMPLETED", "FAILED"]);

    await addStop(route.routeId, 30, "PENDING");

    const response = await arrival(carrier.driverToken, route, {
      "x-trajetto-client-version": CONTRACT_5,
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      code: "CHECKLIST_ARRIVAL_ROUTE_OPEN",
      open_stops: 1,
    });
  });

  it("refuses a released route that never left", async () => {
    // releasedRoute: the carrier's own truck, released, nothing to count.
    const response = await post(
      checklistUrl,
      carrier.driverToken,
      await checklistBody(carrier, {
        routeId: releasedRoute,
        phase: "ROUTE_END",
      }),
      { "x-trajetto-client-version": CONTRACT_5 },
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toEqual({
      code: "CHECKLIST_ARRIVAL_ROUTE_OPEN",
      message:
        "O checklist de chegada só pode ser feito depois que a rota for iniciada e todas as entregas forem resolvidas.",
      open_stops: 0,
    });
  });

  it("records it from an older build, or one that sends no header, and the trail says how many were open", async () => {
    for (const headers of [
      { "x-trajetto-client-version": CONTRACT_4 },
      {} as Record<string, string>,
    ]) {
      const route = await runningRoute(["COMPLETED", "PENDING"]);

      const response = await arrival(carrier.driverToken, route, headers);

      expect(response.statusCode, response.body).toBe(201);

      const created = await prisma.domainOutboxEvent.findFirstOrThrow({
        where: {
          topic: "vehicle-checklist.created",
          aggregateId: response.json().id,
        },
      });

      expect(created.payload).toMatchObject({
        origin: "MOBILE_APP",
        arrivalOpenStops: 1,
      });
    }
  });

  it("never asks the office, whatever the build", async () => {
    const route = await runningRoute(["PENDING", "PENDING"]);

    const response = await arrival(carrier.managerToken, route, {
      "x-trajetto-client-version": CONTRACT_5,
    });

    expect(response.statusCode, response.body).toBe(201);

    const created = await prisma.domainOutboxEvent.findFirstOrThrow({
      where: {
        topic: "vehicle-checklist.created",
        aggregateId: response.json().id,
      },
    });

    expect(created.payload).not.toHaveProperty("arrivalOpenStops");
  });

  it("never asks the departure checklist (D08)", async () => {
    const route = await runningRoute(["PENDING"]);

    const response = await arrival(
      carrier.driverToken,
      route,
      { "x-trajetto-client-version": CONTRACT_5 },
      { phase: "ROUTE_START" },
    );

    expect(response.statusCode, response.body).toBe(201);
  });

  it("answers a resend of a recorded arrival with it, even after a stop was added", async () => {
    const route = await runningRoute(["COMPLETED"]);
    const body = await checklistBody(carrier, {
      vehicleId: route.vehicleId,
      driverId: carrier.driverId,
      routeId: route.routeId,
      phase: "ROUTE_END",
    });
    const headers = { "x-trajetto-client-version": CONTRACT_5 };

    const first = await post(checklistUrl, carrier.driverToken, body, headers);

    expect(first.statusCode, first.body).toBe(201);

    await addStop(route.routeId, 20, "PENDING");

    const resend = await post(checklistUrl, carrier.driverToken, body, {
      ...headers,
      "idempotency-key": body.client_submission_id,
    });

    expect(resend.statusCode, resend.body).toBe(201);
    expect(resend.json().id).toBe(first.json().id);
  });
});

describe("a released route keeps its vehicle (D10)", () => {
  const updateRoute = (routeId: string, body: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/route/update-route/${routeId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${carrier.managerToken}` },
      payload: body,
    });

  it("refuses clearing the vehicle of a released route", async () => {
    const routeId = await seedRoute(
      carrier,
      carrier.driverId,
      carrier.vehicleId,
    );

    const response = await updateRoute(routeId, { vehicleId: null });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("ROUTE_VEHICLE_REQUIRED");
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: routeId } }))
        .vehicleId,
    ).toBe(carrier.vehicleId);
  });

  it("still lets a planned route drop its vehicle", async () => {
    const routeId = await seedRoute(
      carrier,
      carrier.driverId,
      carrier.vehicleId,
      "PLANNED",
    );

    const response = await updateRoute(routeId, { vehicleId: null });

    expect(response.statusCode).toBe(200);
  });
});

describe("the vehicle's responsible person (F1)", () => {
  const updateVehicle = (token: string, body: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/vehicle/update-vehicle/${carrier.vehicleId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });

  it("is a user of the same company, and null hands it back to the admins", async () => {
    const fleetManager = await seedUser(prisma, CARRIER, "BUSINESS_ADMIN");

    const set = await updateVehicle(carrier.managerToken, {
      responsibleUserId: fleetManager.id,
    });

    expect(set.statusCode).toBe(200);
    expect(
      (
        await prisma.vehicle.findUniqueOrThrow({
          where: { id: carrier.vehicleId },
        })
      ).responsibleUserId,
    ).toBe(fleetManager.id);

    const cleared = await updateVehicle(carrier.managerToken, {
      responsibleUserId: null,
    });

    expect(cleared.statusCode).toBe(200);
    expect(
      (
        await prisma.vehicle.findUniqueOrThrow({
          where: { id: carrier.vehicleId },
        })
      ).responsibleUserId,
    ).toBeNull();
  });

  it("names the responsible person and the branch on the vehicle's detail and list", async () => {
    // Red before: only responsibleUserId and branchId left, so the edit
    // showed "Responsável atual" and the OS could not prefill the branch.
    const fleetManager = await seedUser(prisma, CARRIER, "BUSINESS_ADMIN");

    expect(
      (
        await updateVehicle(carrier.managerToken, {
          responsibleUserId: fleetManager.id,
        })
      ).statusCode,
    ).toBe(200);

    const branch = await prisma.branch.findUniqueOrThrow({
      where: { id: carrier.branchId },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/vehicle/get-vehicle/${carrier.vehicleId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${carrier.managerToken}` },
    });

    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      responsibleUserId: fleetManager.id,
      responsibleUser: { name: "Gestora" },
      branchId: carrier.branchId,
      branch: { name: branch.corporate_reason },
    });

    const list = await app.inject({
      method: "GET",
      url: `/vehicle/list-vehicle?page=1&pageSize=50&businessId=${CARRIER}`,
      headers: { authorization: `Bearer ${carrier.managerToken}` },
    });

    expect(list.statusCode, list.body).toBe(200);

    const rows = list.body
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const row = rows.find((entry) => entry.id === carrier.vehicleId);

    expect(row).toMatchObject({
      responsibleUser: { name: "Gestora" },
      branch: {
        corporate_reason: branch.corporate_reason,
        name: branch.corporate_reason,
      },
    });

    // Without a responsible person, null (the admins answer).
    await updateVehicle(carrier.managerToken, { responsibleUserId: null });

    const cleared = await app.inject({
      method: "GET",
      url: `/vehicle/get-vehicle/${carrier.vehicleId}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${carrier.managerToken}` },
    });

    expect(cleared.json().responsibleUser).toBeNull();
  });

  it("answers another company's user exactly like one that does not exist", async () => {
    const stranger = await seedUser(prisma, OTHER, "BUSINESS_ADMIN");

    const answers = [];

    for (const responsibleUserId of [stranger.id, randomUUID()]) {
      const response = await updateVehicle(carrier.managerToken, {
        responsibleUserId,
      });

      answers.push({
        status: response.statusCode,
        code: response.json().code,
        message: response.json().message,
      });
    }

    expect(answers[0]).toMatchObject({
      status: 400,
      code: "RESPONSIBLE_USER_NOT_FOUND",
    });
    expect(answers[1]).toEqual(answers[0]);
  });
});

describe("the fleet lists name the route (contract C3)", () => {
  const lines = (body: string) =>
    body
      .split("\n")
      .filter(Boolean)
      .slice(1)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const get = (url: string) =>
    app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${carrier.managerToken}` },
    });

  it("sends the route and the moment on every checklist row, null outside a route", async () => {
    const response = await get(
      `/vehicle-checklist/list-vehicle-checklist?businessId=${CARRIER}&page=1&pageSize=100`,
    );

    expect(response.statusCode, response.body).toBe(200);

    const rows = lines(response.body);
    const onRoute = rows.find(
      (row) => row.routeId === releasedRoute && row.phase === "ROUTE_START",
    );
    const standalone = rows.find((row) => row.routeId === null);

    expect(onRoute).toMatchObject({
      route: { id: releasedRoute, code: expect.any(String) },
    });
    expect(
      String((onRoute?.route as { code: string } | undefined)?.code),
    ).toMatch(/^\d+$/);
    expect(standalone).toMatchObject({ route: null, phase: null });
  });

  it("sends the route on every refuelling row of the list and of the vehicle history", async () => {
    const listed = lines(
      (await get(`/fuel/list-fuel?businessId=${CARRIER}&page=1&pageSize=100`))
        .body,
    );

    expect(listed.find((row) => row.routeId === releasedRoute)).toMatchObject({
      route: { id: releasedRoute, code: expect.any(String) },
    });
    for (const row of listed) {
      expect(row).toHaveProperty("route");
    }

    const history = await get(
      `/fuel/search-fuel-by-vehicle/${carrier.vehicleId}?businessId=${CARRIER}&limit=50`,
    );

    expect(history.statusCode, history.body).toBe(200);
    expect(
      lines(history.body).find((row) => row.routeId === releasedRoute),
    ).toMatchObject({ route: { id: releasedRoute, code: expect.any(String) } });
  });
});
