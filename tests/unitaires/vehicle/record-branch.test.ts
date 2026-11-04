import "reflect-metadata";

import { describe, expect, it, vi } from "vitest";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import type { Branch } from "@/modules/branch/dtos/branch-dto";
import { CreateVehicleChecklistUseCase } from "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-usecase";
import { CreateFuelUseCase } from "@/modules/fuel/usecases/create-fuel/create-fuel-usecase";
import {
  activeBranchLookups,
  resolveActiveRecordBranchId,
  resolveRecordBranchId,
} from "@/shared/vehicle/record-branch";

/**
 * The branch a checklist or a refuelling is filed under (finding of the
 * closing review, 03/11/2026).
 *
 * Branch is optional on the vehicle and on the driver, but both use cases
 * refused with 400 BRANCH_REQUIRED when neither had one. The app treats a
 * 400 as a permanent refusal: the driver's departure checklist never went
 * through, and with the company asking for it the route never started — the
 * driver stuck on an admin's data gap. The branch now resolves vehicle →
 * driver → the company's single ACTIVE branch; BRANCH_REQUIRED is left only
 * for a company where even that names nothing (no active branch, or several).
 *
 * A driver's record resolves through ACTIVE branches only (wave 3.7): a
 * vehicle branch switched off after the release falls through to the
 * driver's, then to the company's single active one, instead of refusing
 * with BRANCH_INACTIVE. When nothing resolves the refusal stays (409
 * BRANCH_REQUIRED) and the dispatcher is told, once per route and phase.
 */
const CARRIER = "018fb400-0000-7000-8000-00000000000a";
const OTHER = "018fb400-0000-7000-8000-00000000000b";

const VEHICLE = "018fb400-0000-7000-8000-0000000000c1";
const DRIVER = "018fb400-0000-7000-8000-0000000000d1";
const DRIVER_USER = "018fb400-0000-7000-8000-0000000000e1";
const MANAGER = "018fb400-0000-7000-8000-0000000000e2";
const ROUTE = "018fb400-0000-7000-8000-0000000000f1";

const HEAD_OFFICE = "018fb400-0000-7000-8000-0000000000b1";
const SECOND_BRANCH = "018fb400-0000-7000-8000-0000000000b2";
const CLOSED_BRANCH = "018fb400-0000-7000-8000-0000000000b3";
const FOREIGN_BRANCH = "018fb400-0000-7000-8000-0000000000b9";

function branch(id: string, businessId: string, is_active = true): Branch {
  return { id, businessId, is_active } as Branch;
}

function branchesOf(...rows: Branch[]): InMemoryBranchRepository {
  const repository = new InMemoryBranchRepository();
  repository.branches.push(...rows);
  return repository;
}

describe("resolveRecordBranchId", () => {
  it("takes the vehicle's branch first, then the driver's, and only then asks for the company's", async () => {
    const sole = vi.fn(async () => HEAD_OFFICE);

    expect(
      await resolveRecordBranchId(
        { vehicleBranchId: SECOND_BRANCH, driverBranchId: CLOSED_BRANCH },
        sole,
      ),
    ).toBe(SECOND_BRANCH);
    expect(
      await resolveRecordBranchId(
        { vehicleBranchId: null, driverBranchId: CLOSED_BRANCH },
        sole,
      ),
    ).toBe(CLOSED_BRANCH);
    // No query for the company's branches while the record names one.
    expect(sole).not.toHaveBeenCalled();

    expect(
      await resolveRecordBranchId(
        { vehicleBranchId: null, driverBranchId: undefined },
        sole,
      ),
    ).toBe(HEAD_OFFICE);
    expect(await resolveRecordBranchId({}, async () => null)).toBeNull();
  });
});

describe("resolveActiveRecordBranchId (a driver's record)", () => {
  const company = () =>
    branchesOf(
      branch(HEAD_OFFICE, CARRIER),
      branch(SECOND_BRANCH, CARRIER),
      branch(CLOSED_BRANCH, CARRIER, false),
      branch(FOREIGN_BRANCH, OTHER),
    );

  it("takes the vehicle's branch while it is active, asking nothing more", async () => {
    const branches = company();
    const sole = vi.spyOn(branches, "findSoleActiveBranchId");

    expect(
      await resolveActiveRecordBranchId(
        { vehicleBranchId: SECOND_BRANCH, driverBranchId: HEAD_OFFICE },
        activeBranchLookups(branches, CARRIER),
      ),
    ).toBe(SECOND_BRANCH);
    expect(sole).not.toHaveBeenCalled();
  });

  it("falls through an inactive vehicle branch to the driver's, then to the company's single active one", async () => {
    expect(
      await resolveActiveRecordBranchId(
        { vehicleBranchId: CLOSED_BRANCH, driverBranchId: HEAD_OFFICE },
        activeBranchLookups(company(), CARRIER),
      ),
    ).toBe(HEAD_OFFICE);

    expect(
      await resolveActiveRecordBranchId(
        { vehicleBranchId: CLOSED_BRANCH, driverBranchId: null },
        activeBranchLookups(
          branchesOf(
            branch(HEAD_OFFICE, CARRIER),
            branch(CLOSED_BRANCH, CARRIER, false),
          ),
          CARRIER,
        ),
      ),
    ).toBe(HEAD_OFFICE);
  });

  it("never takes another company's branch, nor a missing one", async () => {
    expect(
      await resolveActiveRecordBranchId(
        {
          vehicleBranchId: FOREIGN_BRANCH,
          driverBranchId: "018fb400-0000-7000-8000-0000000000bf",
        },
        activeBranchLookups(
          branchesOf(
            branch(HEAD_OFFICE, CARRIER),
            branch(FOREIGN_BRANCH, OTHER),
          ),
          CARRIER,
        ),
      ),
    ).toBe(HEAD_OFFICE);
  });

  it("names nothing when no active branch is left to choose", async () => {
    // An inactive vehicle branch, no driver branch, two active ones.
    expect(
      await resolveActiveRecordBranchId(
        { vehicleBranchId: CLOSED_BRANCH, driverBranchId: null },
        activeBranchLookups(company(), CARRIER),
      ),
    ).toBeNull();
  });
});

describe("the company's single active branch", () => {
  it("is the one active branch of THIS company, or nothing", async () => {
    // Only one active: it, even next to an inactive one and to another
    // company's branch.
    expect(
      await branchesOf(
        branch(HEAD_OFFICE, CARRIER),
        branch(CLOSED_BRANCH, CARRIER, false),
        branch(FOREIGN_BRANCH, OTHER),
      ).findSoleActiveBranchId(CARRIER),
    ).toBe(HEAD_OFFICE);

    // Two active: no single answer, so none is guessed.
    expect(
      await branchesOf(
        branch(HEAD_OFFICE, CARRIER),
        branch(SECOND_BRANCH, CARRIER),
      ).findSoleActiveBranchId(CARRIER),
    ).toBeNull();

    // Only inactive ones, or only another company's: nothing.
    expect(
      await branchesOf(
        branch(CLOSED_BRANCH, CARRIER, false),
        branch(FOREIGN_BRANCH, OTHER),
      ).findSoleActiveBranchId(CARRIER),
    ).toBeNull();
  });
});

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

const manager = {
  id: MANAGER,
  role: "BUSINESS_ADMIN",
  businessId: CARRIER,
  driverId: null,
};

const PLATE = "ABC1D23";

interface Crew {
  /** The vehicle's branch; null is what the admin left blank. */
  vehicleBranchId?: string | null;
  /** The driver's branch; null is what the admin left blank. */
  driverBranchId?: string | null;
  /** The record names the driver's released route (C4/C5). */
  routed?: boolean;
}

function crewOf({ vehicleBranchId = null, driverBranchId = null }: Crew) {
  return {
    vehicle: {
      id: VEHICLE,
      businessId: CARRIER,
      driverId: DRIVER,
      status: "ACTIVE",
      current_mileage: 1_000,
      fuelTypeId: "ft",
      branchId: vehicleBranchId,
      license_plate: PLATE,
      description: "Caminhão",
    },
    driver: {
      id: DRIVER,
      businessId: CARRIER,
      status: "ACTIVE",
      name: "Rita Barros",
      branchId: driverBranchId,
    },
  };
}

/** The driver's released route, with this vehicle. */
const route = {
  id: ROUTE,
  businessId: CARRIER,
  code: 42,
  status: "RELEASED",
  driverId: DRIVER,
  vehicleId: VEHICLE,
  driver: { id: DRIVER, name: "Rita Barros" },
};

function outboxStub() {
  return { publish: vi.fn(), publishOnce: vi.fn(async () => true) };
}

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

function checklistUseCase(
  caller: typeof driverUser | typeof manager,
  branches: InMemoryBranchRepository,
  crew: Crew = {},
) {
  const write = vi.fn(async (data: Record<string, unknown>) => ({
    checklist: { id: "c1", ...data },
    created: true,
  }));
  const outbox = outboxStub();
  const { vehicle, driver } = crewOf(crew);

  const useCase = new CreateVehicleChecklistUseCase(
    { findUserById: stub(caller) } as never,
    {
      findBusinessById: stub({
        id: CARRIER,
        ai_analysis_limit: 0,
        timezone: "America/Sao_Paulo",
      }),
    } as never,
    {
      findVehicleById: stub(vehicle),
      canDriverOperateVehicle: stub(true),
    } as never,
    { findDriverById: stub(driver) } as never,
    branches,
    {
      findBySubmissionId: stub(null),
      createVehicleChecklistWithMileage: write,
    } as never,
    outbox as never,
    { resolvePresignedUploads: stub([]), deleteFile: vi.fn() } as never,
    { findRouteById: stub(route) } as never,
  );

  const input = {
    ...ANSWERS,
    businessId: CARRIER,
    vehicleId: VEHICLE,
    driverId: DRIVER,
    current_mileage: 1_100,
    checklist_date: new Date(Date.now() - 60_000).toISOString(),
    created_from: "MOBILE_APP",
    ...(crew.routed && { routeId: ROUTE, phase: "ROUTE_START" }),
  };

  return { useCase, write, input, outbox };
}

function fuelUseCase(
  caller: typeof driverUser | typeof manager,
  branches: InMemoryBranchRepository,
  crew: Crew = {},
) {
  const write = vi.fn(async (data: Record<string, unknown>) => ({
    fuel: { id: "f1", driverId: DRIVER, odometer_photo: null, ...data },
    created: true,
  }));
  const outbox = outboxStub();
  const { vehicle, driver } = crewOf(crew);

  const useCase = new CreateFuelUseCase(
    { findUserById: stub(caller) } as never,
    {
      findBusinessById: stub({
        id: CARRIER,
        ai_analysis_limit: 0,
        timezone: "America/Sao_Paulo",
      }),
    } as never,
    {
      findVehicleById: stub(vehicle),
      canDriverOperateVehicle: stub(true),
    } as never,
    { findDriverById: stub(driver) } as never,
    { findFuelTypeById: stub({ id: "ft", businessId: CARRIER }) } as never,
    branches,
    { findBySubmissionId: stub(null), createFuelWithMileage: write } as never,
    outbox as never,
    { resolvePresignedUploads: stub([]), deleteFile: vi.fn() } as never,
    { findRouteById: stub(route) } as never,
  );

  const input = {
    businessId: CARRIER,
    vehicleId: VEHICLE,
    driverId: DRIVER,
    fuelTypeId: "ft",
    current_mileage: 1_100,
    liters_amount: 10,
    price_per_liter: 5,
    refueling_date: new Date(Date.now() - 60_000).toISOString(),
    created_from: "WEB_DASHBOARD",
    ...(crew.routed && { routeId: ROUTE }),
  };

  return { useCase, write, input, outbox };
}

describe("a driver's checklist with no branch on the vehicle or the driver", () => {
  it("is filed under the company's single active branch", async () => {
    const { useCase, write, input } = checklistUseCase(
      driverUser,
      branchesOf(
        branch(HEAD_OFFICE, CARRIER),
        branch(CLOSED_BRANCH, CARRIER, false),
        branch(FOREIGN_BRANCH, OTHER),
      ),
    );

    await useCase.execute(input as never, DRIVER_USER, []);

    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toMatchObject({ branchId: HEAD_OFFICE });
  });

  it("is still refused with 409 BRANCH_REQUIRED when the company has several active branches", async () => {
    const { useCase, write, input } = checklistUseCase(
      driverUser,
      branchesOf(branch(HEAD_OFFICE, CARRIER), branch(SECOND_BRANCH, CARRIER)),
    );

    await expect(
      useCase.execute(input as never, DRIVER_USER, []),
    ).rejects.toMatchObject({ statusCode: 409, code: "BRANCH_REQUIRED" });
    expect(write).not.toHaveBeenCalled();
  });

  it("never borrows another company's only branch", async () => {
    const { useCase, write, input } = checklistUseCase(
      driverUser,
      branchesOf(branch(FOREIGN_BRANCH, OTHER)),
    );

    await expect(
      useCase.execute(input as never, DRIVER_USER, []),
    ).rejects.toMatchObject({ code: "BRANCH_REQUIRED" });
    expect(write).not.toHaveBeenCalled();
  });

  it("resolves the same way for a manager who left the branch blank", async () => {
    const { useCase, write, input } = checklistUseCase(
      manager,
      branchesOf(branch(HEAD_OFFICE, CARRIER)),
    );

    await useCase.execute(input as never, MANAGER, []);

    expect(write.mock.calls[0][0]).toMatchObject({ branchId: HEAD_OFFICE });
  });

  it("leaves the manager's refusal as it was: 400 BRANCH_REQUIRED, nobody else told", async () => {
    const { useCase, write, input, outbox } = checklistUseCase(
      manager,
      branchesOf(branch(HEAD_OFFICE, CARRIER), branch(SECOND_BRANCH, CARRIER)),
      { routed: true },
    );

    await expect(
      useCase.execute(input as never, MANAGER, []),
    ).rejects.toMatchObject({ statusCode: 400, code: "BRANCH_REQUIRED" });
    expect(write).not.toHaveBeenCalled();
    expect(outbox.publishOnce).not.toHaveBeenCalled();
  });
});

describe("a driver's route checklist after the vehicle's branch was switched off", () => {
  it("is filed under the driver's active branch instead of being refused", async () => {
    const { useCase, write, input, outbox } = checklistUseCase(
      driverUser,
      branchesOf(
        branch(HEAD_OFFICE, CARRIER),
        branch(SECOND_BRANCH, CARRIER),
        branch(CLOSED_BRANCH, CARRIER, false),
      ),
      {
        vehicleBranchId: CLOSED_BRANCH,
        driverBranchId: SECOND_BRANCH,
        routed: true,
      },
    );

    await useCase.execute(input as never, DRIVER_USER, []);

    expect(write.mock.calls[0][0]).toMatchObject({
      branchId: SECOND_BRANCH,
      routeId: ROUTE,
      phase: "ROUTE_START",
    });
    expect(outbox.publishOnce).not.toHaveBeenCalled();
  });

  it("is filed under the company's single active branch when the driver has none", async () => {
    const { useCase, write, input } = checklistUseCase(
      driverUser,
      branchesOf(
        branch(HEAD_OFFICE, CARRIER),
        branch(CLOSED_BRANCH, CARRIER, false),
      ),
      { vehicleBranchId: CLOSED_BRANCH, routed: true },
    );

    await useCase.execute(input as never, DRIVER_USER, []);

    expect(write.mock.calls[0][0]).toMatchObject({ branchId: HEAD_OFFICE });
  });

  it("keeps the manager's semantics: a vehicle branch switched off is still BRANCH_INACTIVE", async () => {
    const { useCase, write, input } = checklistUseCase(
      manager,
      branchesOf(
        branch(HEAD_OFFICE, CARRIER),
        branch(CLOSED_BRANCH, CARRIER, false),
      ),
      { vehicleBranchId: CLOSED_BRANCH, driverBranchId: HEAD_OFFICE },
    );

    await expect(
      useCase.execute(input as never, MANAGER, []),
    ).rejects.toMatchObject({ statusCode: 409, code: "BRANCH_INACTIVE" });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("a driver's route checklist with no active branch to file it under", () => {
  const nothingToResolve = () =>
    branchesOf(
      branch(HEAD_OFFICE, CARRIER),
      branch(SECOND_BRANCH, CARRIER),
      branch(CLOSED_BRANCH, CARRIER, false),
    );

  it("is refused with 409 BRANCH_REQUIRED and tells the dispatcher, keyed by route and phase", async () => {
    const { useCase, write, input, outbox } = checklistUseCase(
      driverUser,
      nothingToResolve(),
      { vehicleBranchId: CLOSED_BRANCH, routed: true },
    );

    await expect(
      useCase.execute(input as never, DRIVER_USER, []),
    ).rejects.toMatchObject({ statusCode: 409, code: "BRANCH_REQUIRED" });
    expect(write).not.toHaveBeenCalled();

    expect(outbox.publishOnce).toHaveBeenCalledOnce();
    expect(outbox.publishOnce).toHaveBeenCalledWith({
      topic: "route.record_branch_missing",
      aggregateType: "route",
      aggregateId: ROUTE,
      businessId: CARRIER,
      actorId: DRIVER_USER,
      eventKey: `route.record_branch_missing:${ROUTE}:ROUTE_START`,
      payload: {
        routeId: ROUTE,
        businessId: CARRIER,
        code: 42,
        record: "CHECKLIST",
        phase: "ROUTE_START",
        driverName: "Rita Barros",
        vehiclePlate: PLATE,
      },
    });
  });

  it("asks for the same key on every retry: the outbox keeps one", async () => {
    const { useCase, input, outbox } = checklistUseCase(
      driverUser,
      nothingToResolve(),
      { routed: true },
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        useCase.execute(
          { ...input, client_submission_id: `retry-${attempt}` } as never,
          DRIVER_USER,
          [],
        ),
      ).rejects.toMatchObject({ code: "BRANCH_REQUIRED" });
    }

    const keys = outbox.publishOnce.mock.calls.map(
      (call) => (call as unknown as [{ eventKey: string }])[0].eventKey,
    );
    expect(new Set(keys)).toEqual(
      new Set([`route.record_branch_missing:${ROUTE}:ROUTE_START`]),
    );
  });

  it("still answers the refusal when the notice cannot be written", async () => {
    const { useCase, input, outbox } = checklistUseCase(
      driverUser,
      nothingToResolve(),
      { routed: true },
    );
    outbox.publishOnce.mockRejectedValueOnce(new Error("database down"));

    await expect(
      useCase.execute(input as never, DRIVER_USER, []),
    ).rejects.toMatchObject({ statusCode: 409, code: "BRANCH_REQUIRED" });
  });

  it("tells nobody about a checklist that names no route", async () => {
    const { useCase, input, outbox } = checklistUseCase(
      driverUser,
      nothingToResolve(),
    );

    await expect(
      useCase.execute(input as never, DRIVER_USER, []),
    ).rejects.toMatchObject({ statusCode: 409, code: "BRANCH_REQUIRED" });
    expect(outbox.publishOnce).not.toHaveBeenCalled();
  });
});

describe("a driver's refuelling with no branch on the vehicle or the driver", () => {
  it("is filed under the company's single active branch", async () => {
    const { useCase, write, input } = fuelUseCase(
      driverUser,
      branchesOf(
        branch(HEAD_OFFICE, CARRIER),
        branch(CLOSED_BRANCH, CARRIER, false),
        branch(FOREIGN_BRANCH, OTHER),
      ),
    );

    await useCase.execute(input as never, DRIVER_USER);

    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toMatchObject({ branchId: HEAD_OFFICE });
  });

  it("is still refused with 409 BRANCH_REQUIRED when nothing names a single branch", async () => {
    const { useCase, write, input } = fuelUseCase(
      driverUser,
      branchesOf(branch(HEAD_OFFICE, CARRIER), branch(SECOND_BRANCH, CARRIER)),
    );

    await expect(
      useCase.execute(input as never, DRIVER_USER),
    ).rejects.toMatchObject({ statusCode: 409, code: "BRANCH_REQUIRED" });
    expect(write).not.toHaveBeenCalled();
  });

  it("resolves the same way for a manager who left the branch blank", async () => {
    const { useCase, write, input } = fuelUseCase(
      manager,
      branchesOf(branch(HEAD_OFFICE, CARRIER)),
    );

    await useCase.execute(input as never, MANAGER);

    expect(write.mock.calls[0][0]).toMatchObject({ branchId: HEAD_OFFICE });
  });

  it("leaves the manager's refusal as it was: 400 BRANCH_REQUIRED", async () => {
    const { useCase, input, outbox } = fuelUseCase(
      manager,
      branchesOf(branch(HEAD_OFFICE, CARRIER), branch(SECOND_BRANCH, CARRIER)),
      { routed: true },
    );

    await expect(
      useCase.execute(input as never, MANAGER),
    ).rejects.toMatchObject({ statusCode: 400, code: "BRANCH_REQUIRED" });
    expect(outbox.publishOnce).not.toHaveBeenCalled();
  });
});

describe("a driver's route refuelling", () => {
  it("falls through a vehicle branch switched off to the driver's active one", async () => {
    const { useCase, write, input } = fuelUseCase(
      driverUser,
      branchesOf(
        branch(HEAD_OFFICE, CARRIER),
        branch(SECOND_BRANCH, CARRIER),
        branch(CLOSED_BRANCH, CARRIER, false),
      ),
      {
        vehicleBranchId: CLOSED_BRANCH,
        driverBranchId: SECOND_BRANCH,
        routed: true,
      },
    );

    await useCase.execute(input as never, DRIVER_USER);

    expect(write.mock.calls[0][0]).toMatchObject({
      branchId: SECOND_BRANCH,
      routeId: ROUTE,
    });
  });

  it("with nothing to resolve, is refused (409) and tells the dispatcher once per route", async () => {
    const { useCase, input, outbox } = fuelUseCase(
      driverUser,
      branchesOf(branch(HEAD_OFFICE, CARRIER), branch(SECOND_BRANCH, CARRIER)),
      { routed: true },
    );

    await expect(
      useCase.execute(input as never, DRIVER_USER),
    ).rejects.toMatchObject({ statusCode: 409, code: "BRANCH_REQUIRED" });

    expect(outbox.publishOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "route.record_branch_missing",
        businessId: CARRIER,
        eventKey: `route.record_branch_missing:${ROUTE}:FUEL`,
        payload: expect.objectContaining({
          record: "FUEL",
          phase: null,
          code: 42,
          vehiclePlate: PLATE,
          driverName: "Rita Barros",
        }),
      }),
    );
  });
});
