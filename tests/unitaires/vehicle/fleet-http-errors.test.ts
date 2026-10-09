import { describe, expect, it } from "vitest";
import type { FastifyReply } from "fastify";

import { replyVehicleError } from "@/modules/vehicle/usecases/errors/vehicle-http-errors";
import { replyChecklistError } from "@/modules/vehicle-checklist/usecases/errors/vehicle-checklist-http-errors";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";
import { VehicleTypeNotFoundError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-found-error";
import { VehicleTypeNotBelongBusinessError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-belong-business-error";
import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";
import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { VehicleChecklistNotFoundError } from "@/modules/vehicle-checklist/usecases/errors/vehicle-checklist-not-found-error";
import { VehicleChecklistBusinessNotFoundError } from "@/modules/vehicle-checklist/usecases/errors/vehicle-checklist-business-not-found-error";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";
import { VehicleMileageOutOfOrderError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-out-of-order-error";

/**
 * Another company's id answers exactly like an id that exists nowhere
 * (decisions 8.1 and 11.3): same status, code AND sentence. A different
 * sentence alone ("Este motorista não pertence a esta empresa!") told any
 * caller that the id exists in some other tenant.
 */
interface Sent {
  status?: number;
  header?: string;
  body?: { code?: string; message?: string };
}

function answer(
  reply: (reply: FastifyReply, error: unknown) => boolean,
  error: Error,
): Sent {
  const sent: Sent = {};
  const fake = {
    header(name: string, value: string) {
      if (name === "x-error-code") sent.header = value;
      return fake;
    },
    status(code: number) {
      sent.status = code;
      return fake;
    },
    send(body: Sent["body"]) {
      sent.body = body;
      return fake;
    },
  };

  expect(reply(fake as unknown as FastifyReply, error)).toBe(true);

  return sent;
}

describe("the vehicle routes' answers", () => {
  it.each([
    ["vehicle type", new VehicleTypeNotBelongBusinessError(), new VehicleTypeNotFoundError()],
    ["fuel type", new FuelTypeNotBelongBusinessError(), new FuelTypeNotFoundError()],
    ["driver", new DriverNotBelongBusinessError(), new DriverNotFoundError()],
    ["branch", new BranchNotBelongBusinessError(), new BranchNotFoundError()],
    ["vehicle", new VehicleNotBelongBusinessError(), new VehicleNotFoundError()],
  ])("answers another company's %s like a missing one", (_, foreign, missing) => {
    const fromForeign = answer(replyVehicleError, foreign);

    expect(fromForeign).toEqual(answer(replyVehicleError, missing));
    expect(fromForeign.body?.message).not.toMatch(/pertence/);
  });
});

describe("the checklist routes' answers", () => {
  it.each([
    ["vehicle", new VehicleNotBelongBusinessError(), new VehicleNotFoundError()],
    ["driver", new DriverNotBelongBusinessError(), new DriverNotFoundError()],
    ["branch", new BranchNotBelongBusinessError(), new BranchNotFoundError()],
    [
      "checklist",
      new VehicleChecklistBusinessNotFoundError(),
      new VehicleChecklistNotFoundError(),
    ],
  ])("answers another company's %s like a missing one", (_, foreign, missing) => {
    const fromForeign = answer(replyChecklistError, foreign);

    expect(fromForeign).toEqual(answer(replyChecklistError, missing));
    expect(fromForeign.body?.message).not.toMatch(/pertence/);
    expect(fromForeign.header).toBe(fromForeign.body?.code);
  });

  it("gives an edit out of order among its neighbours its own code and sentence", () => {
    // Red before: VEHICLE_MILEAGE_INVALID and "must be greater than the
    // vehicle's current mileage", also when only the date had moved.
    const outOfOrder = answer(
      replyChecklistError,
      new VehicleMileageOutOfOrderError({ before: 17_000, after: 18_200 }),
    );

    expect(outOfOrder).toMatchObject({
      status: 400,
      header: "VEHICLE_MILEAGE_OUT_OF_ORDER",
      body: { code: "VEHICLE_MILEAGE_OUT_OF_ORDER" },
    });
    expect(outOfOrder.body?.message).toContain("entre 17.000 km e 18.200 km");

    expect(answer(replyChecklistError, new VehicleMileageInvalidError())).toMatchObject({
      status: 400,
      body: { code: "VEHICLE_MILEAGE_INVALID" },
    });
  });

  it("refuses a driver's vehicle they may not operate as the other fleet routes do", () => {
    expect(answer(replyChecklistError, new VehicleNotAssignedToDriverError())).toMatchObject({
      status: 403,
      header: "VEHICLE_NOT_ASSIGNED_TO_DRIVER",
      body: { code: "VEHICLE_NOT_ASSIGNED_TO_DRIVER" },
    });
  });
});
