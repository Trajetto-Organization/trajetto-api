import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { FuelRepository } from "@/modules/fuel/repositories/fuel-repository";
import type { CreateFuelProps } from "@/modules/fuel/dtos/fuel-dto";
import { VehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/vehicle-checklist-repository";
import type { CreateVehicleChecklistProps } from "@/modules/vehicle-checklist/dtos/vehicle-checklist-dto";
import { createPrismaClient } from "@/shared/database/database-client";
import { isSerializationFailure } from "@/shared/errors/prisma-error-meta";

import {
  seedBranch,
  seedBusiness,
  seedDriver,
  seedFuelType,
  seedVehicle,
} from "../contract/seed";

/**
 * A serializable fueling or checklist write that Postgres refuses at COMMIT
 * is retried, not answered with a 500.
 *
 * The fuel and checklist repositories run their writes in a serializable
 * transaction and run them again when a concurrent record got there first.
 * Two records of one truck that only read its timeline and insert (a
 * refueling queued offline and a checklist of last week, say) conflict in a
 * way Postgres' serializable checking usually notices at COMMIT. Prisma 6
 * reported that as P2034. Prisma 7.10.1 + adapter-pg runs the COMMIT outside
 * its error mapping and hands back the bare DriverAdapterError
 * (`TransactionWriteConflict`, 40001), and the loops, which tested for
 * P2034 alone, gave up after one attempt: the request failed and the record
 * was lost (measured: Prisma 6 wrote both records, Prisma 7 one).
 *
 * The race is held open by hand. The repository gets the test client with
 * one seam in `$transaction`: after the repository's last statement, with
 * its transaction still open, a rival record of the same truck commits on
 * another client, the way a second replica would. Both read a timeline the
 * other writes into, so the open one is the pivot of a dangerous structure
 * whose other end committed first, and Postgres cancels it "during commit
 * attempt". Every attempt is recorded, so each test proves where the first
 * one failed (after the work, i.e. at COMMIT) and that the loop ran again.
 *
 * All four loops are covered: the create and the edit of each record kind.
 * Every record here is historical (between two readings, the odometer left
 * alone), so the rival never waits on a row lock the open transaction holds.
 */
const prisma = createPrismaClient();

// The rival commits through its own client and pool, as another replica.
const rivalPrisma = createPrismaClient();

const BUSINESS = "018fe5c0-0000-7000-8000-00000000000a";

let branchId = "";
let driverId = "";
let fuelTypeId = "";
let vehicleSeq = 0;

const day = (date: string) => new Date(`2026-10-${date}T15:00:00.000Z`);

interface Attempt {
  /** The repository's work ran to its end: what failed after is the COMMIT. */
  workDone: boolean;
  error?: unknown;
}

type TransactionOptions = {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
};

/**
 * The test client with one seam in `$transaction`: attempt `n` runs
 * `rivals[n]` (when there is one) after the repository's work and before
 * Prisma sends the COMMIT.
 */
function seamed(rivals: Array<() => Promise<unknown>>) {
  const attempts: Attempt[] = [];

  const transaction = async (
    work: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: TransactionOptions,
  ) => {
    const rival = rivals[attempts.length];
    const attempt: Attempt = { workDone: false };
    attempts.push(attempt);

    try {
      return await prisma.$transaction(async (tx) => {
        const result = await work(tx);

        if (rival) await rival();

        attempt.workDone = true;

        return result;
      }, options);
    } catch (error) {
      attempt.error = error;
      throw error;
    }
  };

  const client = new Proxy(prisma, {
    get(target, property) {
      if (property === "$transaction") return transaction;

      const value = Reflect.get(target, property);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return { client, attempts };
}

/** The first attempt failed at COMMIT, on a serialization failure, once. */
function expectRetriedAfterCommitConflict(attempts: Attempt[]): void {
  expect(attempts).toHaveLength(2);
  expect(attempts[0].workDone).toBe(true);
  expect(isSerializationFailure(attempts[0].error)).toBe(true);
  expect(attempts[1].error).toBeUndefined();
}

async function newVehicle(): Promise<string> {
  vehicleSeq += 1;

  const plate = `SRL${String(vehicleSeq).padStart(4, "0")}`;
  const vehicle = await seedVehicle(prisma, BUSINESS, plate, {
    current_mileage: 500,
    fuelTypeId,
    branchId,
  });

  return vehicle.id;
}

function refueling(
  vehicleId: string,
  mileage: number,
  date: string,
): CreateFuelProps {
  return {
    client_submission_id: randomUUID(),
    current_mileage: mileage,
    liters_amount: 100,
    price_per_liter: 6,
    odometer_photo: `fuelOdometer/${BUSINESS}/odometro.webp`,
    refueling_date: day(date),
    created_from: "MOBILE_APP",
    businessId: BUSINESS,
    branchId,
    driverId,
    vehicleId,
    fuelTypeId,
  };
}

function checklist(
  vehicleId: string,
  mileage: number,
  date: string,
): CreateVehicleChecklistProps {
  return {
    client_submission_id: randomUUID(),
    current_mileage: mileage,
    checklist_date: day(date),
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
    photos: [],
    overall_condition: "approved",
    businessId: BUSINESS,
    branchId,
    driverId,
    vehicleId,
  };
}

/** Readings of 1 000 km on 1 Oct and 2 000 km on 20 Oct: odometer 2 000. */
async function fuelTimeline(vehicleId: string): Promise<void> {
  const repository = new FuelRepository(prisma);

  await repository.createFuelWithMileage(refueling(vehicleId, 1000, "01"));
  await repository.createFuelWithMileage(refueling(vehicleId, 2000, "20"));
}

async function checklistTimeline(vehicleId: string): Promise<void> {
  const repository = new VehicleChecklistRepository(prisma);

  await repository.createVehicleChecklistWithMileage(
    checklist(vehicleId, 1000, "01"),
  );
  await repository.createVehicleChecklistWithMileage(
    checklist(vehicleId, 2000, "20"),
  );
}

/** A refueling of the truck, committed on the rival client. */
function rivalRefueling(vehicleId: string, mileage: number, date: string) {
  const repository = new FuelRepository(rivalPrisma);

  return () =>
    repository.createFuelWithMileage(refueling(vehicleId, mileage, date));
}

/** A checklist of the truck, committed on the rival client. */
function rivalChecklist(vehicleId: string, mileage: number, date: string) {
  const repository = new VehicleChecklistRepository(rivalPrisma);

  return () =>
    repository.createVehicleChecklistWithMileage(
      checklist(vehicleId, mileage, date),
    );
}

async function fuelMileages(vehicleId: string): Promise<number[]> {
  const rows = await prisma.fuel.findMany({
    where: { vehicleId },
    orderBy: { refueling_date: "asc" },
    select: { current_mileage: true },
  });

  return rows.map((row) => row.current_mileage);
}

async function checklistMileages(vehicleId: string): Promise<number[]> {
  const rows = await prisma.vehicleChecklist.findMany({
    where: { vehicleId },
    orderBy: { checklist_date: "asc" },
    select: { current_mileage: true },
  });

  return rows.map((row) => row.current_mileage);
}

async function odometer(vehicleId: string): Promise<number> {
  const vehicle = await prisma.vehicle.findUniqueOrThrow({
    where: { id: vehicleId },
    select: { current_mileage: true },
  });

  return vehicle.current_mileage;
}

beforeAll(async () => {
  await seedBusiness(prisma, BUSINESS, 1);
  branchId = (await seedBranch(prisma, BUSINESS, 1)).id;
  driverId = (await seedDriver(prisma, BUSINESS, 1)).id;
  fuelTypeId = (await seedFuelType(prisma, BUSINESS)).id;
});

afterAll(async () => {
  await rivalPrisma.$disconnect();
  await prisma.$disconnect();
});

describe("a refueling whose COMMIT loses to a concurrent record", () => {
  it("is created on the retry (createFuelWithMileage)", async () => {
    const vehicleId = await newVehicle();
    await fuelTimeline(vehicleId);

    const { client, attempts } = seamed([
      rivalRefueling(vehicleId, 1500, "08"),
    ]);

    const result = await new FuelRepository(client).createFuelWithMileage(
      refueling(vehicleId, 1200, "05"),
    );

    expect(result.created).toBe(true);
    expectRetriedAfterCommitConflict(attempts);
    expect(await fuelMileages(vehicleId)).toEqual([1000, 1200, 1500, 2000]);
    expect(await odometer(vehicleId)).toBe(2000);
  });

  it("is edited on the retry (updateFuelAndMileage)", async () => {
    const vehicleId = await newVehicle();
    await fuelTimeline(vehicleId);

    const { fuel } = await new FuelRepository(prisma).createFuelWithMileage(
      refueling(vehicleId, 1200, "05"),
    );

    const { client, attempts } = seamed([
      rivalRefueling(vehicleId, 1500, "08"),
    ]);

    const edited = await new FuelRepository(client).updateFuelAndMileage(
      { fuelId: fuel.id, fuelData: { current_mileage: 1300 } },
      {
        businessId: BUSINESS,
        vehicleId,
        currentMileage: 1300,
        at: day("05"),
        fuelId: fuel.id,
      },
    );

    expect(edited.current_mileage).toBe(1300);
    expectRetriedAfterCommitConflict(attempts);
    expect(await fuelMileages(vehicleId)).toEqual([1000, 1300, 1500, 2000]);
  });

  it("still gives up after three attempts, with the conflict itself", async () => {
    const vehicleId = await newVehicle();
    await fuelTimeline(vehicleId);

    const { client, attempts } = seamed([
      rivalRefueling(vehicleId, 1500, "08"),
      rivalRefueling(vehicleId, 1600, "09"),
      rivalRefueling(vehicleId, 1700, "10"),
    ]);

    const repository = new FuelRepository(client);
    const outcome = repository.createFuelWithMileage(
      refueling(vehicleId, 1200, "05"),
    );

    await expect(outcome).rejects.toSatisfy(isSerializationFailure);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((attempt) => attempt.workDone)).toBe(true);
    expect(await fuelMileages(vehicleId)).toEqual([
      1000, 1500, 1600, 1700, 2000,
    ]);
  });
});

describe("a checklist whose COMMIT loses to a concurrent record", () => {
  it("is created on the retry (createVehicleChecklistWithMileage)", async () => {
    const vehicleId = await newVehicle();
    await checklistTimeline(vehicleId);

    const { client, attempts } = seamed([
      rivalChecklist(vehicleId, 1500, "08"),
    ]);

    const repository = new VehicleChecklistRepository(client);
    const result = await repository.createVehicleChecklistWithMileage(
      checklist(vehicleId, 1200, "05"),
    );

    expect(result.created).toBe(true);
    expectRetriedAfterCommitConflict(attempts);
    expect(await checklistMileages(vehicleId)).toEqual([
      1000, 1200, 1500, 2000,
    ]);
    expect(await odometer(vehicleId)).toBe(2000);
  });

  it("is edited on the retry, against a refueling (updateVehicleChecklistAndMileage)", async () => {
    const vehicleId = await newVehicle();
    await checklistTimeline(vehicleId);

    const { checklist: stored } = await new VehicleChecklistRepository(
      prisma,
    ).createVehicleChecklistWithMileage(checklist(vehicleId, 1200, "05"));

    // One timeline holds both kinds: a refueling committed meanwhile is as
    // much a conflict as another checklist.
    const { client, attempts } = seamed([
      rivalRefueling(vehicleId, 1500, "08"),
    ]);

    const repository = new VehicleChecklistRepository(client);
    const edited = await repository.updateVehicleChecklistAndMileage(
      { checklistId: stored.id, checklistData: { current_mileage: 1300 } },
      {
        businessId: BUSINESS,
        vehicleId,
        currentMileage: 1300,
        at: day("05"),
        checklistId: stored.id,
      },
    );

    expect(edited.current_mileage).toBe(1300);
    expectRetriedAfterCommitConflict(attempts);
    expect(await checklistMileages(vehicleId)).toEqual([1000, 1300, 2000]);
    expect(await fuelMileages(vehicleId)).toEqual([1500]);
  });
});
