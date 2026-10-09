import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCatalogChangedEvent = vi.hoisted(() => vi.fn());

vi.mock("@/websocket", () => ({ sendCatalogChangedEvent }));

import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";
import { CreateFuelTypeUseCase } from "@/modules/fuel-type/usecases/create-fuel-type/create-fuel-type-usecase";
import { UpdateFuelTypeUseCase } from "@/modules/fuel-type/usecases/update-fuel-type/update-fuel-type-usecase";
import { DeleteFuelTypeUseCase } from "@/modules/fuel-type/usecases/delete-fuel-type/delete-fuel-type-usecase";
import { ListFuelTypeUseCase } from "@/modules/fuel-type/usecases/list-fuel-type/list-fuel-type-usecase";
import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";
import { FuelTypeHasAssociatedVehiclesError } from "@/modules/fuel-type/usecases/errors/fuel-type-has-associated-vehicles-error";
import { FuelTypeAlreadyExistsError } from "@/modules/fuel-type/usecases/errors/fuel-type-already-exists-error";

/**
 * The fuel types catalog: every write tells the company's open screens
 * (`catalogChanged` fuel_type, decision 2.3) after it happened — and only
 * then — and the twin answers as the repository does.
 */
const A = "018fe700-0000-7000-8000-00000000000a";
const B = "018fe700-0000-7000-8000-00000000000b";

const admin = { id: "admin", role: "BUSINESS_ADMIN", businessId: A, driverId: null };
const master = { id: "master", role: "MASTER", businessId: null, driverId: null };

function setup(user = admin) {
  const fuelTypes = new InMemoryFuelTypeRepository();
  const users = { findUserById: async () => user } as never;
  const business = {
    findBusinessById: async (id: string) => ({ id, corporate_reason: "Empresa" }),
  } as never;
  const notifications = { createActivityIfEnabled: vi.fn() } as never;

  return {
    fuelTypes,
    create: new CreateFuelTypeUseCase(users, business, fuelTypes, notifications),
    update: new UpdateFuelTypeUseCase(users, business, fuelTypes, notifications),
    remove: new DeleteFuelTypeUseCase(users, business, fuelTypes, notifications),
    list: new ListFuelTypeUseCase(users, fuelTypes, business),
  };
}

beforeEach(() => {
  sendCatalogChangedEvent.mockClear();
});

describe("catalogChanged fuel_type", () => {
  it("is emitted after create, update and delete, for the company written", async () => {
    const { create, update, remove } = setup();

    const created = await create.execute({ description: "Diesel", businessId: A }, "admin");
    await update.execute({ description: "Gasolina" }, created.id, "admin", A);
    await remove.execute(created.id, "admin", A);

    expect(sendCatalogChangedEvent.mock.calls).toEqual([
      [A, "fuel_type"],
      [A, "fuel_type"],
      [A, "fuel_type"],
    ]);
  });

  it("is not emitted when the write is refused", async () => {
    const { create, remove, fuelTypes } = setup();

    await create.execute({ description: "Diesel", businessId: A }, "admin");
    sendCatalogChangedEvent.mockClear();

    await expect(
      create.execute({ description: "diesel", businessId: A }, "admin"),
    ).rejects.toBeInstanceOf(FuelTypeAlreadyExistsError);

    fuelTypes.vehicleFuelTypeIds.push(fuelTypes.fuelTypes[0].id);

    await expect(
      remove.execute(fuelTypes.fuelTypes[0].id, "admin", A),
    ).rejects.toBeInstanceOf(FuelTypeHasAssociatedVehiclesError);

    expect(sendCatalogChangedEvent).not.toHaveBeenCalled();
  });
});

describe("tenant walls in the use cases", () => {
  it("treats another company's fuel type as missing, even for the MASTER naming his own path", async () => {
    const { fuelTypes, update, remove } = setup(master as never);

    const foreign = await fuelTypes.createFuelType({ description: "GNV", businessId: B });

    await expect(
      update.execute({ description: "GLP" }, foreign.id, "master", A),
    ).rejects.toBeInstanceOf(FuelTypeNotFoundError);

    await expect(remove.execute(foreign.id, "master", A)).rejects.toBeInstanceOf(
      FuelTypeNotFoundError,
    );

    expect(fuelTypes.fuelTypes[0]).toMatchObject({ businessId: B, description: "GNV" });
  });

  it("refuses a manager writing into another company", async () => {
    const { create } = setup();

    await expect(
      create.execute({ description: "Diesel", businessId: B }, "admin"),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("makes the MASTER name the company to list", async () => {
    const { list } = setup(master as never);

    await expect(list.execute({ userId: "master", page: 1, pageSize: 10 })).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });
  });
});

describe("InMemoryFuelTypeRepository answers like the repository", () => {
  it("lists newest first, one company, sorted and searched like Postgres", async () => {
    const repo = new InMemoryFuelTypeRepository();

    const base = Date.parse("2026-09-01T00:00:00Z");

    for (const [index, description] of ["Diesel", "Etanol", "Gasolina"].entries()) {
      const row = await repo.createFuelType({ description, businessId: A });
      row.created_at = new Date(base + index * 1000);
    }

    await repo.createFuelType({ description: "GNV", businessId: B });

    const newest = await repo.listFuelTypes({ page: 1, pageSize: 10, businessId: A });

    expect(newest.data.map((row) => row.description)).toEqual([
      "Gasolina",
      "Etanol",
      "Diesel",
    ]);
    expect(newest.total).toBe(3);

    const byName = await repo.listFuelTypes({
      page: 1,
      pageSize: 2,
      businessId: A,
      sort: "description",
      order: "asc",
    });

    expect(byName.data.map((row) => row.description)).toEqual(["Diesel", "Etanol"]);

    const searched = await repo.listFuelTypes({
      page: 1,
      pageSize: 10,
      businessId: A,
      search: "ETA",
    });

    expect(searched.data.map((row) => row.description)).toEqual(["Etanol"]);
  });

  it("matches the description without case, like insensitiveEquals", async () => {
    const repo = new InMemoryFuelTypeRepository();

    await repo.createFuelType({ description: "Diesel", businessId: A });

    expect(await repo.findFuelTypeByDescription("DIESEL", A)).not.toBeNull();
    expect(await repo.findFuelTypeByDescription("DIESEL", B)).toBeNull();
  });

  it("never moves a fuel type to another company on update", async () => {
    const repo = new InMemoryFuelTypeRepository();

    const row = await repo.createFuelType({ description: "Diesel", businessId: A });
    const updated = await repo.updateFuelType({
      fuelTypeId: row.id,
      fuelTypeData: { description: "Etanol", businessId: B } as never,
    });

    expect(updated.businessId).toBe(A);
    expect(updated.description).toBe("Etanol");
  });
});
