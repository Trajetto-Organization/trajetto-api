import "reflect-metadata";

import { describe, expect, it, vi } from "vitest";

import { Decimal } from "@prisma/client/runtime/library";

import { DeleteFuelUseCase } from "@/modules/fuel/usecases/delete-fuel/delete-fuel-usecase";
import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";
import type { Fuel } from "@/modules/fuel/dtos/fuel-dto";

/**
 * Deleting a refueling removes the row first and the odometer photo after.
 *
 * The photo went first: when the row delete then failed (a lock timeout, a
 * dropped connection), the refueling stayed in the list pointing at a file
 * that no longer existed — its evidence gone, the record not.
 */
const BUSINESS = "018fe700-0000-7000-8000-00000000000a";
const PHOTO = `odometerPhotos/${BUSINESS}/prova.webp`;

function seeded(repository: InMemoryFuelRepository): Fuel {
  const fuel = {
    id: "018fe700-0000-7000-8000-0000000000f1",
    client_submission_id: null,
    current_mileage: 1_000,
    liters_amount: new Decimal(10),
    price_per_liter: new Decimal(5),
    total_amount: new Decimal(50),
    odometer_photo: PHOTO,
    odometer_verified: false,
    notes: null,
    refueling_date: new Date("2026-09-01T12:00:00.000Z"),
    businessId: BUSINESS,
    branchId: "b1",
    vehicleId: "v1",
    driverId: "d1",
    fuelTypeId: "ft1",
    latitude: null,
    longitude: null,
    latitude_original: null,
    longitude_original: null,
    location_source: null,
    odometer_ai_status: "pending",
    created_from: "WEB_DASHBOARD",
    created_at: new Date(),
    updated_at: new Date(),
  } as unknown as Fuel;

  repository.fuels.push(fuel);

  return fuel;
}

function useCase(repository: InMemoryFuelRepository, calls: string[]) {
  const uploads = {
    deleteFile: vi.fn(async () => {
      calls.push("photo");
    }),
  };

  const instance = new DeleteFuelUseCase(
    {
      findUserById: async () => ({
        id: "admin",
        role: "BUSINESS_ADMIN",
        businessId: BUSINESS,
        driverId: null,
      }),
    } as never,
    { findBusinessById: async () => ({ id: BUSINESS }) } as never,
    repository,
    { createActivityIfEnabled: vi.fn() } as never,
    uploads as never,
  );

  return { instance, uploads };
}

describe("DeleteFuelUseCase", () => {
  it("deletes the row before the photo", async () => {
    const calls: string[] = [];
    const repository = new InMemoryFuelRepository();
    const fuel = seeded(repository);

    const original = repository.deleteFuel.bind(repository);
    repository.deleteFuel = async (id: string) => {
      calls.push("row");
      return original(id);
    };

    const { instance, uploads } = useCase(repository, calls);

    await instance.execute({ fuelId: fuel.id, businessId: BUSINESS }, "admin");

    expect(calls).toEqual(["row", "photo"]);
    expect(uploads.deleteFile).toHaveBeenCalledWith(PHOTO);
    expect(repository.fuels).toHaveLength(0);
  });

  it("keeps the photo when the row cannot be deleted", async () => {
    const calls: string[] = [];
    const repository = new InMemoryFuelRepository();
    const fuel = seeded(repository);

    repository.deleteFuel = async () => {
      throw new Error("lock timeout");
    };

    const { instance, uploads } = useCase(repository, calls);

    await expect(
      instance.execute({ fuelId: fuel.id, businessId: BUSINESS }, "admin"),
    ).rejects.toMatchObject({ statusCode: 500 });

    expect(uploads.deleteFile).not.toHaveBeenCalled();
    expect(repository.fuels).toHaveLength(1);
  });

  it("answers another company's refueling as not found", async () => {
    const repository = new InMemoryFuelRepository();
    const fuel = seeded(repository);
    const { instance, uploads } = useCase(repository, []);

    await expect(
      instance.execute(
        { fuelId: fuel.id, businessId: "018fe700-0000-7000-8000-00000000000b" },
        "admin",
      ),
    ).rejects.toThrow("não encontrado");

    expect(uploads.deleteFile).not.toHaveBeenCalled();
    expect(repository.fuels).toHaveLength(1);
  });
});
