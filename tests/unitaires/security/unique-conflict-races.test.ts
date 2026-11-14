import "reflect-metadata";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/websocket", () => ({
  sendCatalogChangedEvent: () => undefined,
  sendSecurityEventToBusiness: () => undefined,
}));

// The twins have no transaction; the writes run in order on them.
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

import { CreateProfileAccessUseCase } from "@/modules/profile-access/usecases/create-profile-access/create-profile-access-usecase";
import { UpdateProfileAccessUseCase } from "@/modules/profile-access/usecases/update-profile-access/update-profile-access-usecase";
import { CreatePermissionUseCase } from "@/modules/permission/usecases/create-permission/create-permission-usecase";
import { UpdatePermissionUseCase } from "@/modules/permission/usecases/update-permission/update-permission-usecase";
import { CreateFuelTypeUseCase } from "@/modules/fuel-type/usecases/create-fuel-type/create-fuel-type-usecase";
import { UpdateFuelTypeUseCase } from "@/modules/fuel-type/usecases/update-fuel-type/update-fuel-type-usecase";
import { DeleteFuelTypeUseCase } from "@/modules/fuel-type/usecases/delete-fuel-type/delete-fuel-type-usecase";
import { DeleteVehicleUseCase } from "@/modules/vehicle/usecases/delete-vehicle/delete-vehicle-usecase";

import { FuelTypeHasAssociatedFuelError } from "@/modules/fuel-type/usecases/errors/fuel-type-has-associated-fuel-error";
import { VehicleHasAssociatedFinesError } from "@/modules/vehicle/usecases/errors/vehicle-has-associated-fines-error";

import {
  foreignKeyViolation,
  uniqueViolation,
} from "@/shared/in-memory/prisma-errors";

/**
 * Two requests that both pass the use case's lookup before either writes
 * (batch of 14/11/2026). The loser meets the unique index — or, on a
 * delete, a reference committed after the count meets the foreign key — and
 * used to fall into the generic catch: "Houve um erro… tente novamente"
 * (500). Each case below lets the lookup or the count pass and the write
 * fail as Postgres would: the answer is the 409 the lookup would have given.
 *
 * The e-mail and driver races of the user use cases are in
 * create-update-user-usecases and master-and-user-list-usecases.
 */
const BUSINESS = "018fe800-0000-7000-8000-00000000000a";
const PROFILE = "018fe800-0000-7000-8000-0000000000b1";

const admin = {
  id: "admin",
  role: "BUSINESS_ADMIN",
  businessId: BUSINESS,
  profileAccessId: null,
  driverId: null,
};

const users = { findUserById: async () => admin } as never;
const business = {
  findBusinessById: async (id: string) => ({ id, corporate_reason: "Empresa" }),
} as never;
const notifications = {
  createActivityIfEnabled: async () => undefined,
} as never;

describe("access profiles", () => {
  it("answers two creations of the same name with PROFILE_ACCESS_ALREADY_EXISTS", async () => {
    const profiles = {
      findProfileAccessByNameAndBusiness: async () => null,
      createProfileAccess: async () => {
        throw uniqueViolation(["name", "businessId"]);
      },
    } as never;

    await expect(
      new CreateProfileAccessUseCase(
        users,
        profiles,
        business,
        notifications,
      ).execute({ name: "Operação", businessId: BUSINESS }, "admin"),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PROFILE_ACCESS_ALREADY_EXISTS",
      message: expect.stringContaining("nesta empresa"),
    });
  });

  it("answers a rename into a name taken in between the same way", async () => {
    const profiles = {
      findProfileAccessById: async () => ({
        id: PROFILE,
        name: "Antigo",
        businessId: BUSINESS,
      }),
      findProfileAccessByNameAndBusiness: async () => null,
      updateProfileAccess: async () => {
        throw uniqueViolation(["name", "businessId"]);
      },
    } as never;

    await expect(
      new UpdateProfileAccessUseCase(
        users,
        profiles,
        business,
        notifications,
      ).execute(
        { profileAccessId: PROFILE, businessId: BUSINESS, name: "Novo" },
        "admin",
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PROFILE_ACCESS_ALREADY_EXISTS",
    });
  });
});

describe("permissions", () => {
  const profiles = {
    findProfileAccessById: async () => ({
      id: PROFILE,
      name: "Operação",
      businessId: BUSINESS,
    }),
  } as never;

  it("answers the same grant twice at once with PERMISSION_ALREADY_EXISTS", async () => {
    const permissions = {
      findPermissionNameByProfile: async () => null,
      findPermissionKeyByProfile: async () => null,
      createPermission: async () => {
        throw uniqueViolation(["action", "profileAccessId", "businessId"]);
      },
    } as never;

    await expect(
      new CreatePermissionUseCase(
        users,
        permissions,
        business,
        profiles,
        notifications,
      ).execute(
        {
          action: "fuel_manage",
          permissionKey: "fuel_manage",
          canRead: true,
          canWrite: true,
          businessId: BUSINESS,
          profileAccessId: PROFILE,
        } as never,
        "admin",
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PERMISSION_ALREADY_EXISTS",
    });
  });

  it("answers an edit into a grant created in between the same way", async () => {
    const permissions = {
      findPermissionById: async () => ({
        id: "perm-1",
        action: "fuel_manage",
        businessId: BUSINESS,
        profileAccessId: PROFILE,
      }),
      findPermissionNameByProfile: async () => null,
      findPermissionKeyByProfile: async () => null,
      updatePermission: async () => {
        throw uniqueViolation(["action", "profileAccessId", "businessId"]);
      },
    } as never;

    await expect(
      new UpdatePermissionUseCase(
        users,
        permissions,
        business,
        profiles,
        notifications,
      ).execute(
        {
          permissionId: "perm-1",
          action: "fine_manage",
          permissionKey: "fine_manage",
          canRead: true,
          canWrite: false,
          profileAccessId: PROFILE,
        } as never,
        "admin",
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PERMISSION_ALREADY_EXISTS",
    });
  });
});

describe("fuel types", () => {
  // Ahead of the description index (FLEET-DUP-1): with it, the loser of the
  // race meets it, and the answer must already be the domain's 409.
  it("answers a creation and a rename that meet the index with FUEL_TYPE_ALREADY_EXISTS", async () => {
    const fuelTypes = {
      findFuelTypeByDescription: async () => null,
      findFuelTypeByIdAndBusiness: async () => ({
        id: "ft-1",
        description: "Diesel",
        businessId: BUSINESS,
      }),
      createFuelType: async () => {
        throw uniqueViolation(["businessId", "description"]);
      },
      updateFuelType: async () => {
        throw uniqueViolation(["businessId", "description"]);
      },
    } as never;

    await expect(
      new CreateFuelTypeUseCase(
        users,
        business,
        fuelTypes,
        notifications,
      ).execute({ description: "Diesel S10", businessId: BUSINESS }, "admin"),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "FUEL_TYPE_ALREADY_EXISTS",
      message: "Já existe um tipo de combustível com este nome nesta empresa.",
    });

    await expect(
      new UpdateFuelTypeUseCase(
        users,
        business,
        fuelTypes,
        notifications,
      ).execute({ description: "Diesel S10" }, "ft-1", "admin", BUSINESS),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "FUEL_TYPE_ALREADY_EXISTS",
    });
  });

  it("counts again when a refueling written after the count meets the foreign key", async () => {
    const counts = [
      { vehicles: 0, fuels: 0 },
      { vehicles: 0, fuels: 1 },
    ];
    const fuelTypes = {
      findFuelTypeByIdAndBusiness: async () => ({
        id: "ft-1",
        description: "Diesel",
        businessId: BUSINESS,
      }),
      countFuelTypeUsage: async () => counts.shift(),
      deleteFuelType: async () => {
        throw foreignKeyViolation("fuel_fuelTypeId_fkey");
      },
    } as never;

    await expect(
      new DeleteFuelTypeUseCase(
        users,
        business,
        fuelTypes,
        notifications,
      ).execute("ft-1", "admin", BUSINESS),
    ).rejects.toBeInstanceOf(FuelTypeHasAssociatedFuelError);

    expect(counts).toEqual([]);
  });
});

describe("vehicles", () => {
  const vehicleWith = (usage: Array<Record<string, number>>) =>
    ({
      findVehicleById: async () => ({
        id: "v-1",
        businessId: BUSINESS,
        license_plate: "ABC1D23",
      }),
      countVehicleUsage: async () => usage.shift(),
      deleteVehicle: async () => {
        throw foreignKeyViolation("fine_vehicleId_fkey");
      },
    }) as never;

  const none = {
    fines: 0,
    serviceOrders: 0,
    fuels: 0,
    checklists: 0,
    accountsPayable: 0,
  };
  const deliveries = { countDeliveriesReferencing: async () => 0 } as never;
  const routes = { countRoutesReferencing: async () => 0 } as never;

  it("counts again when a fine written after the count meets the RESTRICT key", async () => {
    const usage = [none, { ...none, fines: 1 }];

    await expect(
      new DeleteVehicleUseCase(
        users,
        business,
        vehicleWith(usage),
        deliveries,
        routes,
        notifications,
      ).execute("v-1", BUSINESS, "admin"),
    ).rejects.toBeInstanceOf(VehicleHasAssociatedFinesError);

    expect(usage).toEqual([]);
  });

  it("falls to RECORD_IN_USE when the recount finds nothing it knows", async () => {
    await expect(
      new DeleteVehicleUseCase(
        users,
        business,
        vehicleWith([none, none]),
        deliveries,
        routes,
        notifications,
      ).execute("v-1", BUSINESS, "admin"),
    ).rejects.toMatchObject({ statusCode: 409, code: "RECORD_IN_USE" });
  });
});
