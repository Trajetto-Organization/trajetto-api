import type { FastifyReply } from "fastify";

import {
  replyFrom,
  type FuelHttpError,
} from "@/modules/fuel/usecases/errors/fuel-http-errors";

import { FuelTypeNotFoundError } from "./fuel-type-not-found-error";
import { FuelTypeNotBelongBusinessError } from "./fuel-type-not-belong-business-error";
import { FuelTypeAlreadyExistsError } from "./fuel-type-already-exists-error";
import { FuelTypeHasAssociatedVehiclesError } from "./fuel-type-has-associated-vehicles-error";
import { FuelTypeHasAssociatedFuelError } from "./fuel-type-has-associated-fuel-error";

/**
 * The fuel-type routes' domain errors, with the same statuses and codes as
 * the fuel routes (decision 11.3: always with a code, in the body and in
 * `x-error-code`). These controllers answered a missing user or company as
 * `400 { message }` with no code, while the fuel writes already answered the
 * same BusinessNotFoundError as 404 BUSINESS_NOT_FOUND.
 *
 * The fuel type is in the PATH here, so a missing or foreign one is a 404,
 * alike (on the fuel routes it is a link in the body: 400).
 */
const FUEL_TYPE_ERRORS: FuelHttpError[] = [
  [FuelTypeNotFoundError, 404, "FUEL_TYPE_NOT_FOUND"],
  [
    FuelTypeNotBelongBusinessError,
    404,
    "FUEL_TYPE_NOT_FOUND",
    new FuelTypeNotFoundError().message,
  ],
  [FuelTypeAlreadyExistsError, 409, "FUEL_TYPE_ALREADY_EXISTS"],
  // Still in use: a conflict with the data, with the count in the sentence.
  [FuelTypeHasAssociatedVehiclesError, 409, "FUEL_TYPE_IN_USE"],
  [FuelTypeHasAssociatedFuelError, 409, "FUEL_TYPE_IN_USE"],
];

/**
 * Sends the mapped answer and returns true, or returns false for an error
 * the table does not know (the caller rethrows it to the error handler).
 */
function replyFuelTypeError(reply: FastifyReply, error: unknown): boolean {
  return replyFrom(FUEL_TYPE_ERRORS, reply, error);
}

export { FUEL_TYPE_ERRORS, replyFuelTypeError };
