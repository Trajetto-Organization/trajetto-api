import { FastifyReply } from "fastify";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { TrafficViolationCodeNotFoundError } from "./errors/traffic-violation-code-not-found-error";
import { FineRegistrationsMobileLocationRequiredError } from "./errors/fine-registrations-mobile-location-required-error";
import { FineLocationNotProvidedAdjustmentValidationError } from "./errors/fine-location-not-provided-adjustment-validation-error";

type ErrorClass = new (...args: never[]) => Error;

/**
 * The refusals of the fine writes, each with a stable `code` (decision
 * 11.3); the controllers used to answer `{ message }` only. A reference to
 * another company's branch, driver or vehicle arrives here as the same
 * "not found" as an unknown id (the use cases decide that).
 */
const FINE_ERRORS: ReadonlyArray<[ErrorClass, number, string]> = [
  [BranchNotFoundError, 400, "BRANCH_NOT_FOUND"],
  [DriverNotFoundError, 400, "DRIVER_NOT_FOUND"],
  [VehicleNotFoundError, 400, "VEHICLE_NOT_FOUND"],
  [TrafficViolationCodeNotFoundError, 400, "TRAFFIC_VIOLATION_CODE_NOT_FOUND"],
  [FineRegistrationsMobileLocationRequiredError, 400, "FINE_LOCATION_REQUIRED"],
  [
    FineLocationNotProvidedAdjustmentValidationError,
    400,
    "FINE_ORIGINAL_LOCATION_REQUIRED",
  ],
];

/** Answers a known refusal and returns the reply; undefined for anything else. */
function sendFineError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply | undefined {
  const match = FINE_ERRORS.find(([ErrorType]) => error instanceof ErrorType);

  if (!match) return undefined;

  const [, status, code] = match;

  return reply
    .header("x-error-code", code)
    .status(status)
    .send({ code, message: (error as Error).message });
}

export { FINE_ERRORS, sendFineError };
