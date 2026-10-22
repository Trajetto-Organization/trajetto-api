import "reflect-metadata";

import Fastify, { type FastifyReply } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/AppError";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";
import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";
import { FuelTypeHasAssociatedFuelError } from "@/modules/fuel-type/usecases/errors/fuel-type-has-associated-fuel-error";

import {
  replyFuelListError,
  replyFuelVehicleReadError,
  replyFuelWriteError,
} from "@/modules/fuel/usecases/errors/fuel-http-errors";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { replyFuelTypeError } from "@/modules/fuel-type/usecases/errors/fuel-type-http-errors";

/**
 * The answers the fuel and fuel-type controllers give each domain error
 * (decision 11.3: honest status, always a code, in the body and in
 * `x-error-code`). Over a real Fastify reply: the tables are what is proven,
 * the reply is only where they write.
 *
 * - The fuel-type controllers and list-fuel answered a missing user or
 *   company as `400 { message }` with no code; both are AppErrors now.
 * - The mileage refusal said "maior que a quilometragem atual do veículo",
 *   the rule for a new refueling only.
 * - A branch of another company went out as 400 to the MASTER, where the
 *   branch gate answers everyone else 404.
 */
type Replier = (reply: FastifyReply, error: unknown) => boolean;

const app = Fastify();

const cases: Record<string, { replier: Replier; error: () => Error }> = {
  "list-user": {
    replier: replyFuelListError,
    error: () => new ResourceNotFoundError(),
  },
  "type-business": {
    replier: replyFuelTypeError,
    error: () => new BusinessNotFoundError(),
  },
  "type-user": {
    replier: replyFuelTypeError,
    error: () => new ResourceNotFoundError(),
  },
  "type-missing": {
    replier: replyFuelTypeError,
    error: () => new FuelTypeNotFoundError(),
  },
  "type-foreign": {
    replier: replyFuelTypeError,
    error: () => new FuelTypeNotBelongBusinessError(),
  },
  "type-in-use": {
    replier: replyFuelTypeError,
    error: () => new FuelTypeHasAssociatedFuelError(3),
  },
  "write-mileage": {
    replier: replyFuelWriteError,
    error: () => new VehicleMileageInvalidError(),
  },
  "write-branch-missing": {
    replier: replyFuelWriteError,
    error: () => new BranchNotFoundError(),
  },
  "write-branch-foreign": {
    replier: replyFuelWriteError,
    error: () => new BranchNotBelongBusinessError(),
  },
  "type-unknown": {
    replier: replyFuelTypeError,
    error: () => new Error("boom"),
  },
  "read-vehicle-missing": {
    replier: replyFuelVehicleReadError,
    error: () => new VehicleNotFoundError(),
  },
  "read-vehicle-foreign": {
    replier: replyFuelVehicleReadError,
    error: () => new VehicleNotBelongBusinessError(),
  },
};

beforeAll(async () => {
  for (const [name, { replier, error }] of Object.entries(cases)) {
    app.get(`/${name}`, async (_request, reply) => {
      if (replier(reply, error())) return reply;

      return reply.status(599).send({ unmapped: true });
    });
  }

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function answer(name: string) {
  const response = await app.inject({ method: "GET", url: `/${name}` });
  const body = response.json() as {
    code?: string;
    message?: string;
    unmapped?: boolean;
  };

  return {
    status: response.statusCode,
    code: body.code,
    header: response.headers["x-error-code"],
    message: body.message,
    unmapped: body.unmapped,
  };
}

describe("the fuel-type and list tables answer with a code", () => {
  it("leaves a missing user and a missing company to the error handler, as 404 with a code", async () => {
    // The tables used to answer a missing user 400 (another status than the
    // rest of the API for the same code). Both classes now carry their own
    // 404 and code, so every route answers them alike through the handler.
    for (const name of ["list-user", "type-user", "type-business"]) {
      expect(await answer(name)).toMatchObject({ status: 599, unmapped: true });
    }

    expect(new ResourceNotFoundError()).toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
    expect(new BusinessNotFoundError()).toMatchObject({
      statusCode: 404,
      code: "BUSINESS_NOT_FOUND",
    });
    expect(new BusinessNotFoundError()).toBeInstanceOf(AppError);
  });

  it("answers a foreign fuel type exactly like a missing one", async () => {
    const missing = await answer("type-missing");

    expect(missing).toMatchObject({ status: 404, code: "FUEL_TYPE_NOT_FOUND" });
    expect(await answer("type-foreign")).toEqual(missing);
  });

  it("keeps the count in the in-use conflict", async () => {
    const inUse = await answer("type-in-use");

    expect(inUse).toMatchObject({
      status: 409,
      code: "FUEL_TYPE_IN_USE",
      header: "FUEL_TYPE_IN_USE",
    });
    expect(inUse.message).toContain("3 registro(s)");
  });

  it("leaves an error it does not know to the caller", async () => {
    expect(await answer("type-unknown")).toMatchObject({
      status: 599,
      unmapped: true,
    });
  });
});

describe("the fuel write table", () => {
  it("explains the timeline rule instead of 'above the current mileage'", async () => {
    const refusal = await answer("write-mileage");

    expect(refusal).toMatchObject({
      status: 400,
      code: "VEHICLE_MILEAGE_INVALID",
    });
    expect(refusal.message).toContain("entre a leitura anterior e a seguinte");
    expect(refusal.message).not.toBe(new VehicleMileageInvalidError().message);
  });

  it("answers a missing or foreign branch with the gate's 404, alike", async () => {
    const missing = await answer("write-branch-missing");

    expect(missing).toMatchObject({ status: 404, code: "BRANCH_NOT_FOUND" });
    expect(await answer("write-branch-foreign")).toEqual(missing);
  });
});

describe("a vehicle's fuel history (the vehicle is in the path)", () => {
  it("answers another company's vehicle exactly like a missing one: 404 VEHICLE_NOT_FOUND", async () => {
    // The use case refuses a foreign vehicle with its own class; this mapping
    // keeps the answer from confirming that the id exists.
    const missing = await answer("read-vehicle-missing");

    expect(missing).toMatchObject({
      status: 404,
      code: "VEHICLE_NOT_FOUND",
      header: "VEHICLE_NOT_FOUND",
    });
    expect(await answer("read-vehicle-foreign")).toEqual(missing);
  });
});
