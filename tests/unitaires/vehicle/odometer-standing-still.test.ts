import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";
import { Decimal } from "@prisma/client/runtime/client";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import type { Branch } from "@/modules/branch/dtos/branch-dto";
import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";
import type { Fuel } from "@/modules/fuel/dtos/fuel-dto";
import { CreateFuelUseCase } from "@/modules/fuel/usecases/create-fuel/create-fuel-usecase";
import { FuelRecentRefuelError } from "@/modules/fuel/usecases/errors/fuel-recent-refuel-error";
import { replyFuelWriteError } from "@/modules/fuel/usecases/errors/fuel-http-errors";
import { InMemoryVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/in-memory/in-memory-vehicle-checklist-repository";
import { CreateVehicleChecklistUseCase } from "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-usecase";
import { replyChecklistError } from "@/modules/vehicle-checklist/usecases/errors/vehicle-checklist-http-errors";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";
import { VehicleMileageOutOfOrderError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-out-of-order-error";

/**
 * The odometer stands still for a short while (owner, 05/11/2026), through
 * the create use cases and the twins, which share one timeline here as the
 * refuellings and checklists share it in Postgres.
 *
 * The question "Já tem um abastecimento recente" offers "Segundo tanque",
 * "Completar o tanque", "A bomba parou antes": all at the same stop, the
 * same km. The depot refuelling right after the departure checklist, the
 * arrival checklist right after a refuelling, and a record the offline queue
 * delivers after a record of the same km read the same km too. Each had to
 * be typed 1 km higher. A reading may now equal the one next to it on the
 * timeline when that record is less than 30 minutes away; the RECENT_REFUEL
 * question and alert are unchanged.
 */
const CARRIER = "018fb800-0000-7000-8000-00000000000a";
const VEHICLE = "018fb800-0000-7000-8000-0000000000c1";
const DRIVER = "018fb800-0000-7000-8000-0000000000d1";
const DRIVER_USER = "018fb800-0000-7000-8000-0000000000e1";
const BRANCH = "018fb800-0000-7000-8000-0000000000b1";
const ROUTE = "018fb800-0000-7000-8000-0000000000f2";
const PHOTO = `odometerPhotos/${CARRIER}/odometro.jpg`;

const SAO_PAULO = "America/Sao_Paulo";

// 12:00 in São Paulo; the stop at 11:00.
const NOW = new Date("2026-11-05T15:00:00.000Z");
const STOP = new Date("2026-11-05T14:00:00.000Z");

const minutes = (at: Date, delta: number) =>
  new Date(at.getTime() + delta * 60_000);

const CONTRACT_5 = { platform: "android", contract: 5 };

const stub =
  <T>(value: T) =>
  async () =>
    value;

const driverUser = {
  id: DRIVER_USER,
  role: "BUSINESS_USER",
  businessId: CARRIER,
  driverId: DRIVER,
};

const vehicle = {
  id: VEHICLE,
  businessId: CARRIER,
  driverId: DRIVER,
  status: "IN_ROUTE",
  current_mileage: 49_800,
  fuelTypeId: "ft",
  branchId: BRANCH,
  license_plate: "ABC1D23",
  description: "Caminhão",
};

const driver = {
  id: DRIVER,
  businessId: CARRIER,
  status: "ACTIVE",
  name: "Rita Barros",
  branchId: BRANCH,
};

const business = {
  id: CARRIER,
  ai_analysis_limit: 0,
  timezone: SAO_PAULO,
};

/** The driver's route with this truck, every stop done. */
const route = {
  id: ROUTE,
  code: 7,
  businessId: CARRIER,
  driverId: DRIVER,
  vehicleId: VEHICLE,
  status: "IN_PROGRESS",
  released_at: minutes(STOP, -180),
  started_at: minutes(STOP, -120),
  completed_at: null,
  updated_at: STOP,
  stops: [{ id: "stop-1", sequence: 10, status: "COMPLETED" }],
};

const ANSWERS = {
  tires_condition: "good",
  headlights_working: true,
  taillights_working: true,
  turn_signals_working: true,
  bumpers_condition: "good",
  windshield_condition: "good",
  mirrors_condition: "good",
  seatbelts_working: true,
  dashboard_working: true,
  steering_wheel_condition: "good",
  brakes_working: true,
  clutch_working: true,
  fuel_level_adequate: true,
  oil_level_adequate: true,
  radiator_water_adequate: true,
  brake_fluid_adequate: true,
  battery_condition: "good",
  driver_license_valid: true,
  vehicle_documents_valid: true,
  insurance_valid: true,
  fire_extinguisher_valid: true,
  warning_triangle_present: true,
  jack_present: true,
  spare_tire_condition: "good",
  overall_condition: "approved",
};

/** Yesterday's refuelling, the reading before everything below. */
function yesterday(): Fuel {
  return {
    id: "018fb800-0000-7000-8000-000000000001",
    client_submission_id: null,
    current_mileage: 49_800,
    liters_amount: new Decimal("40.000"),
    price_per_liter: new Decimal("6.000"),
    total_amount: new Decimal("240.00"),
    odometer_photo: `odometerPhotos/${CARRIER}/ontem.jpg`,
    odometer_verified: false,
    refueling_date: minutes(STOP, -24 * 60),
    businessId: CARRIER,
    branchId: BRANCH,
    vehicleId: VEHICLE,
    driverId: DRIVER,
    fuelTypeId: "ft",
    odometer_ai_status: "pending",
    created_from: "MOBILE_APP",
    alerts: [],
    recent_refuel_reason: null,
    recent_refuel_previous_at: null,
    created_at: minutes(STOP, -24 * 60),
    updated_at: minutes(STOP, -24 * 60),
  } as Fuel;
}

function fleet() {
  const fuels = new InMemoryFuelRepository();
  const checklists = new InMemoryVehicleChecklistRepository();

  // One timeline and one odometer, as in Postgres.
  fuels.checklists = checklists.checklists;
  checklists.fuels = fuels.fuels;
  checklists.vehicleMileage = fuels.vehicleMileage;
  checklists.vehicleMaintenanceMileage = fuels.vehicleMaintenanceMileage;

  fuels.fuels.push(yesterday());
  fuels.vehicleMileage[VEHICLE] = 49_800;

  const branches = new InMemoryBranchRepository();
  branches.branches.push({
    id: BRANCH,
    businessId: CARRIER,
    is_active: true,
  } as Branch);

  const uploads = {
    resolvePresignedUploads: vi.fn(async (photos: Array<{ key: string }>) =>
      photos.map((photo) => ({ path: photo.key })),
    ),
    deleteFile: vi.fn(),
  };
  const outbox = { publish: vi.fn(), publishOnce: vi.fn(async () => true) };
  const vehicles = {
    findVehicleById: stub(vehicle),
    canDriverOperateVehicle: stub(true),
  };

  const refuelling = new CreateFuelUseCase(
    { findUserById: stub(driverUser) } as never,
    { findBusinessById: stub(business) } as never,
    vehicles as never,
    { findDriverById: stub(driver) } as never,
    { findFuelTypeById: stub({ id: "ft", businessId: CARRIER }) } as never,
    branches,
    fuels,
    outbox as never,
    uploads as never,
    { findRouteById: stub(null) } as never,
  );

  const inspection = new CreateVehicleChecklistUseCase(
    { findUserById: stub(driverUser) } as never,
    { findBusinessById: stub(business) } as never,
    vehicles as never,
    { findDriverById: stub(driver) } as never,
    branches,
    checklists,
    outbox as never,
    uploads as never,
    { findRouteById: stub(route) } as never,
  );

  /** What the app sends for a refuelling tapped at `at`. */
  const refuel = (
    mileage: number,
    at: Date,
    extra: Record<string, unknown> = {},
    submission: { queued?: boolean } = {},
  ) =>
    refuelling.execute(
      {
        businessId: CARRIER,
        vehicleId: VEHICLE,
        fuelTypeId: "ft",
        current_mileage: mileage,
        liters_amount: 35,
        price_per_liter: 6,
        refueling_date: at.toISOString(),
        created_from: "MOBILE_APP",
        client_submission_id: randomUUID(),
        latitude: -23.55,
        longitude: -46.63,
        ...extra,
      } as never,
      DRIVER_USER,
      { key: PHOTO },
      { client: CONTRACT_5, ...submission },
    );

  /** The route's departure or arrival checklist, made at `at`. */
  const inspect = (
    mileage: number,
    at: Date,
    phase: "ROUTE_START" | "ROUTE_END",
  ) =>
    inspection.execute(
      {
        ...ANSWERS,
        businessId: CARRIER,
        vehicleId: VEHICLE,
        driverId: DRIVER,
        branchId: BRANCH,
        current_mileage: mileage,
        checklist_date: at.toISOString(),
        client_submission_id: randomUUID(),
        routeId: ROUTE,
        phase,
      } as never,
      DRIVER_USER,
      [],
      CONTRACT_5,
    );

  const odometer = () => fuels.vehicleMileage[VEHICLE];

  return { fuels, checklists, refuel, inspect, odometer };
}

/** The status, code and message a controller answers an error with. */
function answered(
  reply: (reply: FastifyReply, error: unknown) => boolean,
  error: unknown,
) {
  const sent: { status?: number; code?: string; message?: string } = {};
  const fastifyReply = {
    header() {
      return fastifyReply;
    },
    status(code: number) {
      sent.status = code;
      return fastifyReply;
    },
    send(body: { code: string; message: string }) {
      sent.code = body.code;
      sent.message = body.message;
      return fastifyReply;
    },
  };

  expect(reply(fastifyReply as unknown as FastifyReply, error)).toBe(true);

  return sent;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a second refuelling at the stop, at the first one's km 10 minutes later", () => {
  it("is still asked about, and recorded with RECENT_REFUEL once confirmed", async () => {
    const { fuels, refuel, odometer } = fleet();

    await refuel(50_000, STOP);
    expect(odometer()).toBe(50_000);

    // The point-3 question comes first, unchanged.
    await expect(refuel(50_000, minutes(STOP, 10))).rejects.toBeInstanceOf(
      FuelRecentRefuelError,
    );

    const second = await refuel(50_000, minutes(STOP, 10), {
      confirm_recent: true,
      recent_reason: "Segundo tanque",
    });

    expect(second).toMatchObject({
      current_mileage: 50_000,
      alerts: ["RECENT_REFUEL"],
      recent_refuel_previous_at: STOP,
      recent_refuel_reason: "Segundo tanque",
    });
    expect(odometer()).toBe(50_000);
    expect(fuels.fuels).toHaveLength(3);
  });
});

describe("a refuelling and a checklist of the same stop", () => {
  it("records the depot refuelling 5 minutes after the departure checklist, at its km", async () => {
    const { inspect, refuel, odometer } = fleet();

    await inspect(50_000, STOP, "ROUTE_START");
    expect(odometer()).toBe(50_000);

    const fuel = await refuel(50_000, minutes(STOP, 5));

    // No other refuelling within 30 minutes: no question, no alert.
    expect(fuel).toMatchObject({ current_mileage: 50_000, alerts: [] });
    expect(odometer()).toBe(50_000);
  });

  it("records the arrival checklist at the km of a refuelling 10 minutes before", async () => {
    const { checklists, inspect, refuel, odometer } = fleet();

    await refuel(50_000, STOP);

    const arrival = await inspect(50_000, minutes(STOP, 10), "ROUTE_END");

    expect(arrival).toMatchObject({
      current_mileage: 50_000,
      phase: "ROUTE_END",
    });
    expect(checklists.checklists).toHaveLength(1);
    expect(odometer()).toBe(50_000);
  });

  it("refuses the same km 31 minutes later: 400 VEHICLE_MILEAGE_INVALID, nothing written", async () => {
    const { fuels, checklists, inspect, refuel, odometer } = fleet();

    await refuel(50_000, STOP);

    const checklist = await inspect(
      50_000,
      minutes(STOP, 31),
      "ROUTE_END",
    ).catch((error: unknown) => error);

    expect(checklist).toBeInstanceOf(VehicleMileageInvalidError);
    expect(answered(replyChecklistError, checklist)).toMatchObject({
      status: 400,
      code: "VEHICLE_MILEAGE_INVALID",
      message: expect.stringContaining("menos de 30 minutos de diferença"),
    });

    // Outside the recent-refuel window too: no question, the km refuses it.
    const fuel = await refuel(50_000, minutes(STOP, 31)).catch(
      (error: unknown) => error,
    );

    expect(fuel).toBeInstanceOf(VehicleMileageInvalidError);
    expect(answered(replyFuelWriteError, fuel)).toMatchObject({
      status: 400,
      code: "VEHICLE_MILEAGE_INVALID",
    });

    expect(checklists.checklists).toHaveLength(0);
    expect(fuels.fuels).toHaveLength(2);
    expect(odometer()).toBe(50_000);
  });
});

describe("an odometer a service order raised between two records of the same km", () => {
  it("keeps the strict rule: the record would show the odometer going back", async () => {
    const { fuels, checklists, inspect, refuel, odometer } = fleet();

    await refuel(50_000, STOP);

    // A service order closed at 11:05 with 50.012 km: what
    // advanceMileageAfterService writes on the vehicle, and no reading.
    fuels.vehicleMileage[VEHICLE] = 50_012;
    fuels.vehicleMaintenanceMileage[VEHICLE] = 50_012;

    const arrival = await inspect(50_000, minutes(STOP, 10), "ROUTE_END").catch(
      (error: unknown) => error,
    );

    expect(arrival).toBeInstanceOf(VehicleMileageInvalidError);
    expect(answered(replyChecklistError, arrival)).toMatchObject({
      status: 400,
      code: "VEHICLE_MILEAGE_INVALID",
    });

    // The second tank, confirmed: past the question, the km refuses it.
    await expect(
      refuel(50_000, minutes(STOP, 10), {
        confirm_recent: true,
        recent_reason: "Segundo tanque",
      }),
    ).rejects.toBeInstanceOf(VehicleMileageInvalidError);

    expect(checklists.checklists).toHaveLength(0);
    expect(fuels.fuels).toHaveLength(2);
    expect(odometer()).toBe(50_012);

    // Above the raised odometer, as always.
    await inspect(50_013, minutes(STOP, 10), "ROUTE_END");

    expect(odometer()).toBe(50_013);
  });
});

describe("a refuelling the offline queue delivers after a record of the same km", () => {
  it("is recorded after a later checklist at its km, the odometer unchanged", async () => {
    const { inspect, refuel, odometer } = fleet();

    // The departure checklist at 11:10 reached the server first.
    await inspect(50_000, minutes(STOP, 10), "ROUTE_START");

    const late = await refuel(50_000, STOP, {}, { queued: true });

    expect(late).toMatchObject({ current_mileage: 50_000, alerts: [] });
    expect(odometer()).toBe(50_000);
  });

  it("is recorded, flagged, after a later refuelling at its km", async () => {
    const { refuel, odometer } = fleet();

    await refuel(50_000, minutes(STOP, 10));

    const late = await refuel(50_000, STOP, {}, { queued: true });

    expect(late).toMatchObject({
      current_mileage: 50_000,
      alerts: ["RECENT_REFUEL"],
      recent_refuel_previous_at: minutes(STOP, 10),
      recent_refuel_reason: null,
    });
    expect(odometer()).toBe(50_000);
  });

  it("is refused 40 minutes before it: the strict rule", async () => {
    const { inspect, refuel, odometer } = fleet();

    await inspect(50_000, minutes(STOP, 40), "ROUTE_START");

    await expect(
      refuel(50_000, STOP, {}, { queued: true }),
    ).rejects.toBeInstanceOf(VehicleMileageInvalidError);
    expect(odometer()).toBe(50_000);
  });
});

/**
 * The edits: the office corrects the second tank typed 50.100 for 50.000.
 * The twins pass the record's date to the rule as the repositories do.
 */
describe("an office edit to the km of a record minutes away", () => {
  it("corrects a refuelling, and the odometer it set follows it down", async () => {
    const { fuels, refuel, odometer } = fleet();

    await refuel(50_000, STOP);
    const typo = await refuel(50_100, minutes(STOP, 10), {
      confirm_recent: true,
      recent_reason: "Segundo tanque",
    });

    expect(odometer()).toBe(50_100);

    const correction = (currentMileage: number) =>
      fuels.updateFuelAndMileage(
        { fuelId: typo.id, fuelData: { current_mileage: currentMileage } },
        {
          businessId: CARRIER,
          vehicleId: VEHICLE,
          currentMileage,
          at: minutes(STOP, 10),
          fuelId: typo.id,
          timeZone: SAO_PAULO,
        },
      );

    await expect(correction(49_990)).rejects.toBeInstanceOf(
      VehicleMileageInvalidError,
    );
    expect(odometer()).toBe(50_100);

    await correction(50_000);

    expect(odometer()).toBe(50_000);
  });

  it("corrects a checklist, and names the km it may repeat when refused", async () => {
    const { checklists, inspect, refuel, odometer } = fleet();

    await refuel(50_000, STOP);
    const typo = await inspect(50_100, minutes(STOP, 10), "ROUTE_END");

    expect(odometer()).toBe(50_100);

    const correction = (currentMileage: number) =>
      checklists.updateVehicleChecklistAndMileage(
        {
          checklistId: typo.id,
          checklistData: { current_mileage: currentMileage },
        },
        {
          businessId: CARRIER,
          vehicleId: VEHICLE,
          currentMileage,
          at: minutes(STOP, 10),
          checklistId: typo.id,
          timeZone: SAO_PAULO,
        },
      );

    const refusal = await correction(49_990).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(VehicleMileageOutOfOrderError);
    expect((refusal as Error).message).toContain("maior que 50.000 km");
    expect((refusal as Error).message).toContain(
      "Também pode ser igual a 50.000 km, de um registro com menos de 30 minutos de diferença.",
    );

    await correction(50_000);

    expect(odometer()).toBe(50_000);
  });
});
