import "reflect-metadata";

import { describe, expect, it, vi } from "vitest";

import { Decimal } from "@prisma/client/runtime/library";

import { GetPreviousFuelUseCase } from "@/modules/fuel/usecases/get-previous-fuel/get-previous-fuel-usecase";
import { SearchFuelByVehicleCursorUseCase } from "@/modules/fuel/usecases/search-fuel-by-vehicle-cursor/search-fuel-by-vehicle-cursor-usecase";
import { UpdateFuelUseCase } from "@/modules/fuel/usecases/update-fuel/update-fuel-usecase";

import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { FuelNotFoundError } from "@/modules/fuel/usecases/errors/fuel-not-found-error";
import { FuelDriverCannotUpdateFuelError } from "@/modules/fuel/usecases/errors/fuel-driver-cannot-update-fuel-error";

import type { Fuel } from "@/modules/fuel/dtos/fuel-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";

/**
 * The fuel reads a vehicle's screen makes and the photo side of an edit, on
 * the twins. The odometer timeline and the HTTP refusals are proven over
 * Postgres in tests/E2E/fuel-historical-edit.test.ts and
 * fuel-refusals-http.test.ts; these pin what the use cases themselves
 * decide: another company's vehicle answers like a missing one, a driver
 * reads only a vehicle they operate and only the consumption fields, the
 * photos are signed, and a replaced photo is removed only after the database
 * points at the new one.
 */
const A = "018f0000-0000-7000-8000-00000000000a";
const B = "018f0000-0000-7000-8000-00000000000b";
const ADMIN_A = "018f0000-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000a2";
const OTHER_DRIVER_USER = "018f0000-0000-7000-8000-0000000000a3";
const MASTER = "018f0000-0000-7000-8000-0000000000f1";
const GHOST = "018f0000-0000-7000-8000-0000000000ff";
const DRIVER = "018f0000-0000-7000-8000-0000000002a1";
const OTHER_DRIVER = "018f0000-0000-7000-8000-0000000002a2";
const VEHICLE = "018f0000-0000-7000-8000-0000000003a1";
const FOREIGN_VEHICLE = "018f0000-0000-7000-8000-0000000003b1";
const OLD_PHOTO = `odometerPhotos/${A}/antiga.webp`;

let sequence = 0;

function fuelRow(overrides: Partial<Record<keyof Fuel, unknown>>): Fuel {
  sequence += 1;

  return {
    id: `018f0000-0000-7000-8000-0000000f${String(sequence).padStart(4, "0")}`,
    client_submission_id: null,
    current_mileage: 1_000,
    liters_amount: new Decimal(40),
    price_per_liter: new Decimal(6),
    total_amount: new Decimal(240),
    odometer_photo: null,
    odometer_verified: false,
    notes: "Posto da estrada",
    refueling_date: new Date("2026-09-01T12:00:00.000Z"),
    businessId: A,
    branchId: "branch",
    vehicleId: VEHICLE,
    driverId: DRIVER,
    fuelTypeId: "fuel-type",
    latitude: null,
    longitude: null,
    latitude_original: null,
    longitude_original: null,
    location_source: null,
    odometer_ai_status: "pending",
    created_from: "WEB_DASHBOARD",
    created_at: new Date(Date.UTC(2026, 8, 1, 12, sequence)),
    updated_at: new Date(Date.UTC(2026, 8, 1, 12, sequence)),
    ...overrides,
  } as unknown as Fuel;
}

function makeContext() {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const vehicles = new InMemoryVehicleRepository();
  const fuels = new InMemoryFuelRepository();

  users.user.push(
    {
      id: ADMIN_A,
      role: "BUSINESS_ADMIN",
      businessId: A,
      driverId: null,
    } as unknown as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: A,
      driverId: DRIVER,
    } as unknown as User,
    {
      id: OTHER_DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: A,
      driverId: OTHER_DRIVER,
    } as unknown as User,
    {
      id: MASTER,
      role: "MASTER",
      businessId: null,
      driverId: null,
    } as unknown as User,
  );
  businesses.business.push(
    { id: A, ai_analysis_limit: 0 } as unknown as Business,
    { id: B, ai_analysis_limit: 0 } as unknown as Business,
  );
  vehicles.vehicles.push(
    {
      id: VEHICLE,
      businessId: A,
      driverId: DRIVER,
      status: "ACTIVE",
      license_plate: "ABC1D23",
    } as unknown as Vehicle,
    {
      id: FOREIGN_VEHICLE,
      businessId: B,
      driverId: null,
      status: "ACTIVE",
      license_plate: "XYZ9K88",
    } as unknown as Vehicle,
  );

  const uploads = {
    getFileUrl: vi.fn(
      async (path: string) => `https://assinado.example/${path}`,
    ),
    resolvePresignedUploads: vi.fn(async (items: { key: string }[]) =>
      items.map((item) => ({ path: item.key })),
    ),
    deleteFile: vi.fn(async () => undefined),
  };
  const activities = { createActivityIfEnabled: vi.fn() };

  return {
    fuels,
    uploads,
    previous: new GetPreviousFuelUseCase(users, fuels, vehicles, businesses),
    search: new SearchFuelByVehicleCursorUseCase(
      fuels,
      vehicles,
      users,
      businesses,
      uploads as never,
    ),
    update: new UpdateFuelUseCase(
      users,
      businesses,
      vehicles,
      {} as never,
      {} as never,
      {} as never,
      fuels,
      activities as never,
      uploads as never,
    ),
  };
}

describe("the previous refueling of a vehicle", () => {
  it("returns only the consumption fields of the latest refueling before the date", async () => {
    const context = makeContext();
    context.fuels.fuels.push(
      fuelRow({
        refueling_date: new Date("2026-09-01T12:00:00.000Z"),
        current_mileage: 1_000,
      }),
      fuelRow({
        refueling_date: new Date("2026-09-05T12:00:00.000Z"),
        current_mileage: 1_400,
      }),
      fuelRow({
        refueling_date: new Date("2026-09-09T12:00:00.000Z"),
        current_mileage: 1_800,
      }),
    );

    const previous = await context.previous.execute(
      ADMIN_A,
      VEHICLE,
      "2026-09-08T00:00:00.000Z",
      A,
    );

    expect(previous).toEqual({
      vehicleId: VEHICLE,
      refueling_date: new Date("2026-09-05T12:00:00.000Z"),
      current_mileage: 1_400,
      liters_amount: 40,
    });
  });

  it("answers null when there is none before the date", async () => {
    const context = makeContext();
    context.fuels.fuels.push(
      fuelRow({ refueling_date: new Date("2026-09-09T12:00:00.000Z") }),
    );

    await expect(
      context.previous.execute(ADMIN_A, VEHICLE, "2026-09-01T00:00:00.000Z", A),
    ).resolves.toBeNull();
  });

  it("answers another company's vehicle like a missing one, the MASTER included", async () => {
    const context = makeContext();
    context.fuels.fuels.push(
      fuelRow({ vehicleId: FOREIGN_VEHICLE, businessId: B }),
    );

    const foreign = await context.previous
      .execute(MASTER, FOREIGN_VEHICLE, "2026-12-01T00:00:00.000Z", A)
      .catch((error) => error);
    const missing = await context.previous
      .execute(MASTER, GHOST, "2026-12-01T00:00:00.000Z", A)
      .catch((error) => error);

    expect(foreign).toBeInstanceOf(VehicleNotFoundError);
    expect(missing).toBeInstanceOf(VehicleNotFoundError);
    expect(foreign.message).toBe(missing.message);
  });

  it("refuses another company's id from a company user with TENANT_ACCESS_DENIED", async () => {
    const context = makeContext();

    await expect(
      context.previous.execute(
        ADMIN_A,
        FOREIGN_VEHICLE,
        "2026-12-01T00:00:00.000Z",
        B,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
  });

  it("lets a driver read the vehicle they operate, and refuses a colleague's", async () => {
    const context = makeContext();
    context.fuels.fuels.push(fuelRow({}));

    await expect(
      context.previous.execute(
        DRIVER_USER,
        VEHICLE,
        "2026-12-01T00:00:00.000Z",
        A,
      ),
    ).resolves.toMatchObject({ vehicleId: VEHICLE });
    await expect(
      context.previous.execute(
        OTHER_DRIVER_USER,
        VEHICLE,
        "2026-12-01T00:00:00.000Z",
        A,
      ),
    ).rejects.toBeInstanceOf(VehicleNotAssignedToDriverError);
  });
});

describe("a vehicle's refueling history", () => {
  it("pages the company's refuelings newest first with signed photos", async () => {
    const context = makeContext();
    const older = fuelRow({ odometer_photo: OLD_PHOTO });
    const newer = fuelRow({});
    context.fuels.fuels.push(
      older,
      newer,
      fuelRow({ vehicleId: FOREIGN_VEHICLE, businessId: B }),
    );

    const first = await context.search.execute({
      userId: ADMIN_A,
      vehicleId: VEHICLE,
      limit: 1,
    });

    expect(first.data.map((row) => row.id)).toEqual([newer.id]);
    expect(first.hasMore).toBe(true);

    const second = await context.search.execute({
      userId: ADMIN_A,
      vehicleId: VEHICLE,
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });

    expect(second.data.map((row) => row.id)).toEqual([older.id]);
    expect(second.data[0].odometer_photo).toBe(
      `https://assinado.example/${OLD_PHOTO}`,
    );
  });

  it("shows a driver only their own refuelings of the vehicle they operate", async () => {
    const context = makeContext();
    const mine = fuelRow({});
    context.fuels.fuels.push(mine, fuelRow({ driverId: OTHER_DRIVER }));

    const result = await context.search.execute({
      userId: DRIVER_USER,
      vehicleId: VEHICLE,
    });

    expect(result.data.map((row) => row.id)).toEqual([mine.id]);
    await expect(
      context.search.execute({ userId: OTHER_DRIVER_USER, vehicleId: VEHICLE }),
    ).rejects.toBeInstanceOf(VehicleNotAssignedToDriverError);
  });

  it("refuses another company's vehicle and an unknown one", async () => {
    const context = makeContext();

    // The controller maps this to the same 404 as a missing vehicle.
    await expect(
      context.search.execute({ userId: ADMIN_A, vehicleId: FOREIGN_VEHICLE }),
    ).rejects.toBeInstanceOf(VehicleNotBelongBusinessError);
    await expect(
      context.search.execute({ userId: ADMIN_A, vehicleId: GHOST }),
    ).rejects.toBeInstanceOf(VehicleNotFoundError);
  });

  it("turns a signing failure into a pt-BR 500", async () => {
    const context = makeContext();
    context.fuels.fuels.push(fuelRow({ odometer_photo: OLD_PHOTO }));
    context.uploads.getFileUrl.mockRejectedValueOnce(new Error("storage down"));

    await expect(
      context.search.execute({ userId: ADMIN_A, vehicleId: VEHICLE }),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining("abastecimentos do veículo"),
    });
  });
});

describe("the photo of an edited refueling", () => {
  it("points the record at the new photo, then removes the old one", async () => {
    const context = makeContext();
    const fuel = fuelRow({ odometer_photo: OLD_PHOTO });
    context.fuels.fuels.push(fuel);
    const NEW_PHOTO = `odometerPhotos/${A}/nova.webp`;

    const updated = await context.update.execute(
      {
        fuelId: fuel.id,
        businessId: A,
        fuelData: { notes: "Foto refeita" } as never,
      },
      ADMIN_A,
      { key: NEW_PHOTO },
    );

    expect(updated.odometer_photo).toBe(NEW_PHOTO);
    expect(context.uploads.deleteFile).toHaveBeenCalledTimes(1);
    expect(context.uploads.deleteFile).toHaveBeenCalledWith(OLD_PHOTO);
  });

  it("removes the new photo and keeps the old one when the database refuses the edit", async () => {
    const context = makeContext();
    const fuel = fuelRow({ odometer_photo: OLD_PHOTO });
    context.fuels.fuels.push(fuel);
    const NEW_PHOTO = `odometerPhotos/${A}/nova.webp`;
    vi.spyOn(context.fuels, "updateFuelAndMileage").mockRejectedValueOnce(
      new Error("lock timeout"),
    );

    await expect(
      context.update.execute(
        {
          fuelId: fuel.id,
          businessId: A,
          fuelData: { notes: "Foto refeita" } as never,
        },
        ADMIN_A,
        { key: NEW_PHOTO },
      ),
    ).rejects.toMatchObject({ statusCode: 500 });

    expect(context.uploads.deleteFile).toHaveBeenCalledTimes(1);
    expect(context.uploads.deleteFile).toHaveBeenCalledWith(NEW_PHOTO);
    expect(context.fuels.fuels[0].odometer_photo).toBe(OLD_PHOTO);
  });

  it("refuses a driver before touching storage, and another company's record as missing", async () => {
    const context = makeContext();
    const fuel = fuelRow({});
    const foreign = fuelRow({ vehicleId: FOREIGN_VEHICLE, businessId: B });
    context.fuels.fuels.push(fuel, foreign);

    await expect(
      context.update.execute(
        { fuelId: fuel.id, businessId: A, fuelData: {} as never },
        DRIVER_USER,
        { key: "x" },
      ),
    ).rejects.toBeInstanceOf(FuelDriverCannotUpdateFuelError);
    await expect(
      context.update.execute(
        { fuelId: foreign.id, businessId: A, fuelData: {} as never },
        ADMIN_A,
      ),
    ).rejects.toBeInstanceOf(FuelNotFoundError);
    await expect(
      context.update.execute(
        { fuelId: foreign.id, businessId: B, fuelData: {} as never },
        ADMIN_A,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
    expect(context.uploads.resolvePresignedUploads).not.toHaveBeenCalled();
  });
});
