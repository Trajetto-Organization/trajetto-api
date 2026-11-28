import "reflect-metadata";

import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import type { Branch } from "@/modules/branch/dtos/branch-dto";
import { CreateVehicleChecklistUseCase } from "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-usecase";
import { CreateFuelUseCase } from "@/modules/fuel/usecases/create-fuel/create-fuel-usecase";
import { FuelRegistrationsMobileLocationRequiredError } from "@/modules/fuel/usecases/errors/fuel-registrations-mobile-location-required-error";
import { createFuelSchema } from "@/schemas/create-fuel-schema";
import {
  APP_SUBMISSION_KEY_REQUIRED,
  appSubmissionKeyRefusal,
  resolveRecordOrigin,
} from "@/shared/vehicle/record-origin";

/**
 * Where a refuelling or a checklist was made (owner's test of the driver
 * app, 05/11/2026: every app checklist showed "Web" in the panel).
 *
 * The origin of a driver's record is the server's to decide: MOBILE_APP,
 * whatever the body says. The body is the client's word; a driver's
 * refuelling that said WEB_DASHBOARD skipped the app's rules (GPS point and
 * idempotency key) and a checklist from the app build that never sent the
 * field was stored as from the web. Anybody else keeps what was sent; a
 * checklist that names no origin is the app's when it carries a key (that
 * build is used by the office too) and the web's when it does not.
 */
const CARRIER = "018fb500-0000-7000-8000-00000000000a";
const VEHICLE = "018fb500-0000-7000-8000-0000000000c1";
const DRIVER = "018fb500-0000-7000-8000-0000000000d1";
const DRIVER_USER = "018fb500-0000-7000-8000-0000000000e1";
const MANAGER = "018fb500-0000-7000-8000-0000000000e2";
const BRANCH = "018fb500-0000-7000-8000-0000000000b1";
const KEY = "018fb500-0000-7000-8000-0000000000f1";

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

describe("resolveRecordOrigin", () => {
  it("is MOBILE_APP for a driver, whatever the body says", () => {
    for (const sent of ["WEB_DASHBOARD", "MOBILE_APP", undefined, null]) {
      for (const key of [KEY, undefined]) {
        expect(
          resolveRecordOrigin(
            { role: "BUSINESS_USER", driverId: DRIVER },
            sent as never,
            key,
          ),
        ).toBe("MOBILE_APP");
      }
    }
  });

  it("keeps what anybody else sent, key or not", () => {
    expect(resolveRecordOrigin(manager, "MOBILE_APP", undefined)).toBe(
      "MOBILE_APP",
    );
    expect(resolveRecordOrigin(manager, "WEB_DASHBOARD", KEY)).toBe(
      "WEB_DASHBOARD",
    );
    expect(
      resolveRecordOrigin({ role: "MASTER" }, "WEB_DASHBOARD", undefined),
    ).toBe("WEB_DASHBOARD");
  });

  it("with nothing sent, is the app's with a key and the web's without", () => {
    // Only the app sends a key on a checklist, and the build in drivers'
    // hands (mobile `main`) names no origin, the office's users included.
    expect(resolveRecordOrigin(manager, undefined, KEY)).toBe("MOBILE_APP");
    expect(resolveRecordOrigin(manager, null, KEY)).toBe("MOBILE_APP");
    expect(
      resolveRecordOrigin({ role: "BUSINESS_USER", driverId: null }, null, KEY),
    ).toBe("MOBILE_APP");

    // The web's form sends neither.
    expect(resolveRecordOrigin(manager, undefined, undefined)).toBe(
      "WEB_DASHBOARD",
    );
    expect(resolveRecordOrigin(manager, null, null)).toBe("WEB_DASHBOARD");
    expect(
      resolveRecordOrigin(
        { role: "BUSINESS_USER", driverId: null },
        undefined,
        undefined,
      ),
    ).toBe("WEB_DASHBOARD");
  });

  it("leaves an admin linked to a driver with the office's origin", () => {
    // The web's form for an admin sends no key and no GPS: forcing the app's
    // rules on it would refuse every refuelling they type.
    expect(
      resolveRecordOrigin(
        { role: "BUSINESS_ADMIN", driverId: DRIVER },
        "WEB_DASHBOARD",
        undefined,
      ),
    ).toBe("WEB_DASHBOARD");
  });
});

describe("appSubmissionKeyRefusal", () => {
  it("refuses an app record without its key, as the schema does", () => {
    const refusal = appSubmissionKeyRefusal("MOBILE_APP", undefined);

    // A ZodError, as the schema's: the handler answers it as 400
    // VALIDATION_ERROR with its `issues`, which an AppError would not carry.
    expect(refusal).toBeInstanceOf(ZodError);
    expect(refusal?.issues).toEqual([
      {
        code: "custom",
        path: ["client_submission_id"],
        message: APP_SUBMISSION_KEY_REQUIRED,
      },
    ]);

    // The same sentence createFuelSchema answers for MOBILE_APP without key.
    const parsed = createFuelSchema.safeParse({
      current_mileage: 1000,
      liters_amount: 10,
      price_per_liter: 5,
      refueling_date: "2026-11-05",
      vehicleId: VEHICLE,
      fuelTypeId: "018fb500-0000-7000-8000-0000000000a1",
      created_from: "MOBILE_APP",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toContainEqual(refusal?.issues[0]);
  });

  it("lets through an app record with its key and any web record", () => {
    expect(appSubmissionKeyRefusal("MOBILE_APP", KEY)).toBeNull();
    expect(appSubmissionKeyRefusal("WEB_DASHBOARD", undefined)).toBeNull();
    expect(appSubmissionKeyRefusal("WEB_DASHBOARD", null)).toBeNull();
  });
});

const stub =
  <T>(value: T) =>
  async () =>
    value;

function branches(): InMemoryBranchRepository {
  const repository = new InMemoryBranchRepository();
  repository.branches.push({
    id: BRANCH,
    businessId: CARRIER,
    is_active: true,
  } as Branch);
  return repository;
}

const vehicle = {
  id: VEHICLE,
  businessId: CARRIER,
  driverId: DRIVER,
  status: "ACTIVE",
  current_mileage: 1_000,
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
  timezone: "America/Sao_Paulo",
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

function checklistUseCase(caller: typeof driverUser | typeof manager) {
  const outbox = { publish: vi.fn(), publishOnce: vi.fn(async () => true) };

  // The transaction's hook runs as the repository runs it, so the outbox
  // event the activity trail is written from can be read.
  const write = vi.fn(
    async (
      data: Record<string, unknown>,
      afterCreate?: (tx: unknown, checklist: unknown) => Promise<void>,
    ) => {
      const checklist = { id: "c1", ...data };
      await afterCreate?.({}, checklist);
      return { checklist, created: true };
    },
  );

  const useCase = new CreateVehicleChecklistUseCase(
    { findUserById: stub(caller) } as never,
    { findBusinessById: stub(business) } as never,
    {
      findVehicleById: stub(vehicle),
      canDriverOperateVehicle: stub(true),
    } as never,
    { findDriverById: stub(driver) } as never,
    branches(),
    {
      findBySubmissionId: stub(null),
      createVehicleChecklistWithMileage: write,
    } as never,
    outbox as never,
    { resolvePresignedUploads: stub([]), deleteFile: vi.fn() } as never,
    { findRouteById: stub(null) } as never,
  );

  const input = {
    ...ANSWERS,
    businessId: CARRIER,
    vehicleId: VEHICLE,
    driverId: DRIVER,
    branchId: BRANCH,
    current_mileage: 1_100,
    checklist_date: new Date(Date.now() - 60_000).toISOString(),
  };

  const originPublished = () =>
    (
      outbox.publish.mock.calls.find(
        (call) =>
          (call as unknown as [unknown, { topic: string }])[1].topic ===
          "vehicle-checklist.created",
      ) as unknown as [unknown, { payload: { origin: string } }] | undefined
    )?.[1].payload.origin;

  return { useCase, write, input, originPublished };
}

describe("a checklist's origin", () => {
  it("is MOBILE_APP for a driver whose body said WEB_DASHBOARD", async () => {
    const { useCase, write, input, originPublished } =
      checklistUseCase(driverUser);

    await useCase.execute(
      { ...input, created_from: "WEB_DASHBOARD" } as never,
      DRIVER_USER,
      [],
    );

    expect(write.mock.calls[0][0]).toMatchObject({
      created_from: "MOBILE_APP",
    });
    // The trail says the same ("Origem: Aplicativo").
    expect(originPublished()).toBe("MOBILE_APP");
  });

  it("is MOBILE_APP for a driver whose app never sent the field", async () => {
    // The build in drivers' hands (mobile `main`, multipart) sends none.
    const { useCase, write, input } = checklistUseCase(driverUser);

    await useCase.execute(input as never, DRIVER_USER, []);

    expect(write.mock.calls[0][0]).toMatchObject({
      created_from: "MOBILE_APP",
    });
  });

  it("is WEB_DASHBOARD for the web's form, which sends none", async () => {
    const { useCase, write, input, originPublished } =
      checklistUseCase(manager);

    await useCase.execute(input as never, MANAGER, []);

    expect(write.mock.calls[0][0]).toMatchObject({
      created_from: "WEB_DASHBOARD",
    });
    expect(originPublished()).toBe("WEB_DASHBOARD");
  });

  it("keeps MOBILE_APP for a manager who sent it from the app", async () => {
    const { useCase, write, input } = checklistUseCase(manager);

    await useCase.execute(
      { ...input, created_from: "MOBILE_APP" } as never,
      MANAGER,
      [],
    );

    expect(write.mock.calls[0][0]).toMatchObject({
      created_from: "MOBILE_APP",
    });
  });

  it("is MOBILE_APP for a manager on the app build that names none: its key says so", async () => {
    // Mobile `main` lets the office make checklists too, and sends the key
    // (body and Idempotency-Key) but never the origin; the backfill read the
    // same rows as the app's.
    const { useCase, write, input, originPublished } =
      checklistUseCase(manager);

    await useCase.execute(
      { ...input, client_submission_id: KEY } as never,
      MANAGER,
      [],
    );

    expect(write.mock.calls[0][0]).toMatchObject({
      created_from: "MOBILE_APP",
    });
    expect(originPublished()).toBe("MOBILE_APP");
  });
});

function fuelUseCase(
  caller: typeof driverUser | typeof manager,
  recorded: Record<string, unknown> | null = null,
) {
  const outbox = { publish: vi.fn(), publishOnce: vi.fn(async () => true) };

  const write = vi.fn(
    async (
      data: Record<string, unknown>,
      afterCreate?: (tx: unknown, fuel: unknown) => Promise<void>,
    ) => {
      const fuel = { id: "f1", odometer_photo: null, ...data };
      await afterCreate?.({}, fuel);
      return { fuel, created: true };
    },
  );

  const useCase = new CreateFuelUseCase(
    { findUserById: stub(caller) } as never,
    { findBusinessById: stub(business) } as never,
    {
      findVehicleById: stub(vehicle),
      canDriverOperateVehicle: stub(true),
    } as never,
    { findDriverById: stub(driver) } as never,
    { findFuelTypeById: stub({ id: "ft", businessId: CARRIER }) } as never,
    branches(),
    {
      findBySubmissionId: stub(recorded),
      createFuelWithMileage: write,
    } as never,
    outbox as never,
    { resolvePresignedUploads: stub([]), deleteFile: vi.fn() } as never,
    { findRouteById: stub(null) } as never,
  );

  // What the web's form posts: no key, no GPS.
  const input = {
    businessId: CARRIER,
    vehicleId: VEHICLE,
    driverId: DRIVER,
    fuelTypeId: "ft",
    branchId: BRANCH,
    current_mileage: 1_100,
    liters_amount: 10,
    price_per_liter: 5,
    refueling_date: new Date(Date.now() - 60_000).toISOString(),
    created_from: "WEB_DASHBOARD",
  };

  return { useCase, write, input };
}

const GPS = { latitude: -23.55, longitude: -46.63 };

describe("a driver's refuelling that says WEB_DASHBOARD", () => {
  it("is refused without the GPS point, as the app's (LOCATION_REQUIRED)", async () => {
    const { useCase, write, input } = fuelUseCase(driverUser);

    await expect(
      useCase.execute(
        { ...input, client_submission_id: KEY } as never,
        DRIVER_USER,
      ),
    ).rejects.toBeInstanceOf(FuelRegistrationsMobileLocationRequiredError);
    expect(write).not.toHaveBeenCalled();
  });

  it("is refused without the key, in the schema's words (VALIDATION_ERROR)", async () => {
    const { useCase, write, input } = fuelUseCase(driverUser);

    const refusal = await useCase
      .execute({ ...input, ...GPS } as never, DRIVER_USER)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ZodError);
    expect((refusal as ZodError).issues).toMatchObject([
      { path: ["client_submission_id"], message: APP_SUBMISSION_KEY_REQUIRED },
    ]);
    expect(write).not.toHaveBeenCalled();
  });

  it("with both, is stored as the app's, its point taken as the GPS's", async () => {
    const { useCase, write, input } = fuelUseCase(driverUser);

    await useCase.execute(
      { ...input, ...GPS, client_submission_id: KEY } as never,
      DRIVER_USER,
    );

    expect(write.mock.calls[0][0]).toMatchObject({
      created_from: "MOBILE_APP",
      location_source: "GPS_AUTO",
      latitude_original: GPS.latitude,
      longitude_original: GPS.longitude,
    });
    expect(write.mock.calls[0][0]).not.toHaveProperty("location_edited_by");
  });

  it("is answered with the refuelling already recorded under its key first", async () => {
    // A resend is not a new record: the rules above never see it.
    const recorded = { id: "f0", driverId: DRIVER, created_from: "MOBILE_APP" };
    const { useCase, write, input } = fuelUseCase(driverUser, recorded);

    await expect(
      useCase.execute(
        { ...input, client_submission_id: KEY } as never,
        DRIVER_USER,
      ),
    ).resolves.toBe(recorded);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("a manager's refuelling", () => {
  it("keeps WEB_DASHBOARD, with no key and no GPS (the web's form)", async () => {
    const { useCase, write, input } = fuelUseCase(manager);

    await useCase.execute(input as never, MANAGER);

    expect(write.mock.calls[0][0]).toMatchObject({
      created_from: "WEB_DASHBOARD",
      location_source: "NONE",
    });
  });
});
