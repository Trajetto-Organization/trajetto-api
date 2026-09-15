import { beforeEach, describe, expect, it } from "vitest";

import { UpdateVehicleUseCase } from "@/modules/vehicle/usecases/update-vehicle/update-vehicle-usecase";

import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";
import { InMemoryFuelTypeRepository } from "@/modules/fuel-type/repositories/in-memory/in-memory-fuel-type-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";

import { createVehicleSchema } from "@/schemas/create-vehicle-schema";
import { updateVehicleSchema } from "@/schemas/update-vehicle-schema";

import type { NotificationService } from "@/shared/services/notification-service";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

/**
 * "Em rota" is a fact about a route, not an option in a dropdown.
 *
 * It used to be neither: a value somebody typed into the vehicle form, true
 * until the truck came back and nobody remembered to change it. Hiding the
 * option in the frontend would not have fixed that — it would have left the
 * API accepting it from anything that is not the frontend, which is where the
 * lie would have kept coming from.
 *
 * So the route writes it (proved in the route suites) and these are the other
 * half: nothing else can.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const ADMIN = "018f0000-0000-7000-8000-0000000000a1";
const VEHICLE = "018f0000-0000-7000-8000-0000000000c1";

const notificationStub = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

function makeContext() {
  const vehicleRepository = new InMemoryVehicleRepository();
  const userRepository = new InMemoryUserRepository();
  const businessRepository = new InMemoryBusinessRepository();

  userRepository.user.push({
    id: ADMIN,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  businessRepository.business.push({
    id: BUSINESS,
    corporate_reason: "Transportadora",
    vehicle_limit: 0,
  } as Business);

  vehicleRepository.vehicles.push({
    id: VEHICLE,
    description: "Caminhão",
    license_plate: "AAA1A11",
    status: "ACTIVE",
    businessId: BUSINESS,
    current_mileage: 0,
  } as Vehicle);

  return {
    vehicleRepository,
    update: new UpdateVehicleUseCase(
      userRepository,
      businessRepository,
      new InMemoryVehicleTypeRepository(),
      new InMemoryFuelTypeRepository(),
      new InMemoryDriverRepository(),
      new InMemoryBranchRepository(),
      vehicleRepository,
      notificationStub,
    ),
  };
}

type Context = ReturnType<typeof makeContext>;

let context: Context;

beforeEach(() => {
  context = makeContext();
});

function storedVehicle() {
  return context.vehicleRepository.vehicles.find(
    (entry) => entry.id === VEHICLE,
  )!;
}

describe("the registration form", () => {
  it("does not offer “Em rota” at all", () => {
    // A vehicle cannot be registered already out on a route: there is no route
    // for it to be on yet.
    const result = createVehicleSchema.safeParse({ status: "IN_ROUTE" });

    expect(result.success).toBe(false);

    const statusIssue = result.success
      ? undefined
      : result.error.issues.find((issue) => issue.path[0] === "status");

    expect(statusIssue).toBeDefined();
  });

  it("still offers the three states a person does decide", () => {
    for (const status of ["ACTIVE", "INACTIVE", "BLOCKED"]) {
      const issues = createVehicleSchema
        .safeParse({ status })
        .error?.issues.filter((issue) => issue.path[0] === "status");

      expect(issues ?? []).toEqual([]);
    }
  });
});

describe("the edit form", () => {
  it("parses “Em rota” rather than rejecting it outright", () => {
    // Deliberate: a form that loads a vehicle currently out and saves an
    // unrelated field sends the status back unchanged. Refusing it at the
    // schema would make a truck on the road uneditable.
    expect(updateVehicleSchema.safeParse({ status: "IN_ROUTE" }).success).toBe(
      true,
    );
  });

  it("refuses “Em rota” as an actual change", async () => {
    await expect(
      context.update.execute(
        { status: "IN_ROUTE" },
        VEHICLE,
        BUSINESS,
        ADMIN,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "VEHICLE_STATUS_DERIVED",
    });

    expect(storedVehicle().status).toBe("ACTIVE");
  });

  it("accepts the echo from a truck that really is out", async () => {
    storedVehicle().status = "IN_ROUTE";

    await context.update.execute(
      { status: "IN_ROUTE", description: "Caminhão baú" },
      VEHICLE,
      BUSINESS,
      ADMIN,
    );

    // The unrelated field was saved and the status was left exactly as the
    // route set it.
    expect(storedVehicle().description).toBe("Caminhão baú");
    expect(storedVehicle().status).toBe("IN_ROUTE");
  });

  it("does not carry the echo into the write at all", async () => {
    // The echo looks harmless because it writes the value the row already
    // holds — which is why dropping it survives a naive mutation test. It is
    // not harmless: between this use case reading the vehicle and writing it,
    // the route can end and hand the truck back. The echo would then stamp
    // IN_ROUTE onto a vehicle that is already in the yard, and nothing would
    // ever correct it, because the route that owns the value has finished.
    //
    // So the assertion is about the PATCH, not the outcome: the status must
    // not be in it.
    storedVehicle().status = "IN_ROUTE";

    const patches: Array<Record<string, unknown>> = [];
    const original = context.vehicleRepository.updateVehicle.bind(
      context.vehicleRepository,
    );

    context.vehicleRepository.updateVehicle = async (input) => {
      patches.push(input.vehicleData as unknown as Record<string, unknown>);

      return original(input);
    };

    await context.update.execute(
      { status: "IN_ROUTE", description: "Caminhão baú" },
      VEHICLE,
      BUSINESS,
      ADMIN,
    );

    expect(patches).toHaveLength(1);
    expect(patches[0]).not.toHaveProperty("status");
    expect(patches[0].description).toBe("Caminhão baú");
  });

  it("still lets a person block a truck that is out", async () => {
    // The states a human owns keep working, including on a vehicle the route
    // marked as out — a crash on the road is exactly when someone needs to.
    storedVehicle().status = "IN_ROUTE";

    await context.update.execute(
      { status: "BLOCKED" },
      VEHICLE,
      BUSINESS,
      ADMIN,
    );

    expect(storedVehicle().status).toBe("BLOCKED");
  });
});
