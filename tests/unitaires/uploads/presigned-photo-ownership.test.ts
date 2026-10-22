import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateFuelUseCase } from "@/modules/fuel/usecases/create-fuel/create-fuel-usecase";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";
import {
  checklistPhotoKeys,
  isFinalRejection,
  unreferencedKeys,
} from "@/shared/services/presigned-ownership";
import { AppError } from "@/shared/errors/AppError";

/**
 * The odometer photo the app already uploaded, when the fueling does not end
 * in a new row.
 *
 * The app's outbox retries with the SAME key — it records each upload once and
 * never uploads it again. The use case deleted that object on any failure
 * before the commit and on every replay, so:
 *
 *  - a pool timeout turned into a permanent UPLOADED_FILE_NOT_FOUND on the
 *    retry, and the driver's fueling was lost;
 *  - a replay racing the original deleted the photo of the row the original
 *    had just committed.
 */
const BUSINESS = "018fe000-0000-7000-8000-00000000000a";
const VEHICLE = "018fe000-0000-7000-8000-0000000000v1";
const DRIVER = "018fe000-0000-7000-8000-0000000000d1";
const FUEL_TYPE = "018fe000-0000-7000-8000-0000000000f1";
const BRANCH = "018fe000-0000-7000-8000-0000000000b1";

const KEY = `odometerPhotos/${BUSINESS}/odometro.jpg`;

const deleteFile = vi.fn(async () => undefined);
const createFuelWithMileage = vi.fn();

function useCase(): CreateFuelUseCase {
  const stub =
    <T>(value: T) =>
    async () =>
      value;

  return new CreateFuelUseCase(
    {
      findUserById: stub({
        id: "admin",
        role: "BUSINESS_ADMIN",
        businessId: BUSINESS,
        driverId: null,
      }),
    } as never,
    { findBusinessById: stub({ id: BUSINESS, ai_analysis_limit: 0 }) } as never,
    {
      findVehicleById: stub({
        id: VEHICLE,
        businessId: BUSINESS,
        driverId: null,
        status: "ACTIVE",
        current_mileage: 100,
        fuelTypeId: FUEL_TYPE,
        branchId: BRANCH,
        license_plate: "ABC1D23",
        description: "Caminhão",
      }),
    } as never,
    {
      findDriverById: stub({
        id: DRIVER,
        businessId: BUSINESS,
        status: "ACTIVE",
        branchId: BRANCH,
      }),
    } as never,
    {
      findFuelTypeById: stub({ id: FUEL_TYPE, businessId: BUSINESS }),
    } as never,
    {
      findBranchById: stub({
        id: BRANCH,
        businessId: BUSINESS,
        is_active: true,
      }),
    } as never,
    {
      findBySubmissionId: stub(null),
      createFuelWithMileage,
    } as never,
    { publish: vi.fn() } as never,
    {
      resolvePresignedUploads: async (photos: Array<{ key: string }>) =>
        photos.map((photo) => ({ path: photo.key })),
      deleteFile,
    } as never,
  );
}

const fueling = () =>
  ({
    businessId: BUSINESS,
    vehicleId: VEHICLE,
    driverId: DRIVER,
    fuelTypeId: FUEL_TYPE,
    branchId: BRANCH,
    current_mileage: 200,
    created_from: "WEB_DASHBOARD",
    client_submission_id: "sub-1",
  }) as never;

beforeEach(() => {
  deleteFile.mockClear();
  createFuelWithMileage.mockReset();
});

describe("a fueling that fails for a reason the retry can outlive", () => {
  it("keeps the photo the retry is going to point at", async () => {
    createFuelWithMileage.mockRejectedValue(
      new Error(
        "Timed out fetching a new connection from the connection pool (P2024)",
      ),
    );

    await expect(
      useCase().execute(fueling(), "admin", { key: KEY }),
    ).rejects.toBeDefined();

    expect(deleteFile).not.toHaveBeenCalled();
  });
});

describe("a replay that finds the original already committed", () => {
  it("leaves the committed record's photo alone", async () => {
    createFuelWithMileage.mockResolvedValue({
      created: false,
      fuel: { id: "fuel-1", driverId: DRIVER, odometer_photo: KEY },
    });

    const fuel = await useCase().execute(fueling(), "admin", { key: KEY });

    expect(fuel).toMatchObject({ id: "fuel-1" });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("still cleans up a key the committed record does not use", async () => {
    createFuelWithMileage.mockResolvedValue({
      created: false,
      fuel: {
        id: "fuel-1",
        driverId: DRIVER,
        odometer_photo: "outra-chave.jpg",
      },
    });

    await useCase().execute(fueling(), "admin", { key: KEY });

    expect(deleteFile).toHaveBeenCalledWith(KEY);
  });
});

describe("a fueling the server refuses on its merits", () => {
  it("does delete the photo: no retry will ever use it", async () => {
    createFuelWithMileage.mockRejectedValue(new VehicleMileageInvalidError());

    await expect(
      useCase().execute(fueling(), "admin", { key: KEY }),
    ).rejects.toBeInstanceOf(VehicleMileageInvalidError);

    expect(deleteFile).toHaveBeenCalledWith(KEY);
  });
});

describe("the ownership rules", () => {
  it("call only a 4xx a final rejection", () => {
    expect(isFinalRejection(new AppError("x", 409))).toBe(true);
    expect(isFinalRejection(new AppError("x", 503))).toBe(false);
    expect(isFinalRejection(new Error("P2034 write conflict"))).toBe(false);
    expect(
      isFinalRejection(new VehicleMileageInvalidError(), [
        VehicleMileageInvalidError,
      ]),
    ).toBe(true);
  });

  it("read every key a checklist points at", () => {
    const keys = checklistPhotoKeys({
      photos: ["a", "b"],
      photos_by_field: { pneus: ["c"], painel: "d", vazio: null },
    });

    expect(keys.sort()).toEqual(["a", "b", "c", "d"]);
    expect(unreferencedKeys(["a", "x"], keys)).toEqual(["x"]);
  });
});

describe("a checklist, the same two ways", () => {
  const PHOTOS = [
    { key: `checklistPhotos/${BUSINESS}/pneus.jpg`, fieldName: "pneus" },
    { key: `checklistPhotos/${BUSINESS}/painel.jpg`, fieldName: "painel" },
  ];

  const createVehicleChecklistWithMileage = vi.fn();

  async function checklistUseCase() {
    const { CreateVehicleChecklistUseCase } = await import(
      "@/modules/vehicle-checklist/usecases/create-vehicle-checklist/create-vehicle-checklist-usecase"
    );

    const stub =
      <T>(value: T) =>
      async () =>
        value;

    return new CreateVehicleChecklistUseCase(
      {
        findUserById: stub({
          id: "admin",
          role: "BUSINESS_ADMIN",
          businessId: BUSINESS,
          driverId: null,
        }),
      } as never,
      {
        findBusinessById: stub({ id: BUSINESS, ai_analysis_limit: 0 }),
      } as never,
      {
        findVehicleById: stub({
          id: VEHICLE,
          businessId: BUSINESS,
          driverId: null,
          status: "ACTIVE",
          current_mileage: 100,
          branchId: BRANCH,
          license_plate: "ABC1D23",
          description: "Caminhão",
        }),
      } as never,
      {
        findDriverById: stub({
          id: DRIVER,
          businessId: BUSINESS,
          status: "ACTIVE",
          branchId: BRANCH,
        }),
      } as never,
      {
        findBranchById: stub({
          id: BRANCH,
          businessId: BUSINESS,
          is_active: true,
        }),
      } as never,
      {
        findBySubmissionId: stub(null),
        createVehicleChecklistWithMileage,
      } as never,
      { publish: vi.fn() } as never,
      {
        resolvePresignedUploads: async (
          photos: Array<{ key: string; fieldName?: string }>,
        ) =>
          photos.map((photo) => ({
            path: photo.key,
            fieldName: photo.fieldName,
          })),
        deleteFile,
      } as never,
    );
  }

  const checklist = () =>
    ({
      businessId: BUSINESS,
      vehicleId: VEHICLE,
      driverId: DRIVER,
      branchId: BRANCH,
      current_mileage: 200,
      created_from: "WEB_DASHBOARD",
      client_submission_id: "sub-2",
    }) as never;

  beforeEach(() => {
    createVehicleChecklistWithMileage.mockReset();
  });

  it("keeps the photos when the database was merely busy", async () => {
    createVehicleChecklistWithMileage.mockRejectedValue(
      new Error("Transaction failed due to a write conflict (P2034)"),
    );

    await expect(
      (await checklistUseCase()).execute(checklist(), "admin", PHOTOS),
    ).rejects.toBeDefined();

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("leaves the committed checklist's photos alone on a replay", async () => {
    createVehicleChecklistWithMileage.mockResolvedValue({
      created: false,
      checklist: {
        id: "checklist-1",
        driverId: DRIVER,
        photos: PHOTOS.map((photo) => photo.key),
        photos_by_field: {
          pneus: [PHOTOS[0].key],
          painel: [PHOTOS[1].key],
        },
      },
    });

    await (await checklistUseCase()).execute(checklist(), "admin", PHOTOS);

    expect(deleteFile).not.toHaveBeenCalled();
  });
});
