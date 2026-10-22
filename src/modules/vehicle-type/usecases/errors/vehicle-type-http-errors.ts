import type { FastifyReply } from "fastify";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleTypeNotFoundError } from "./vehicle-type-not-found-error";
import { VehicleTypeNotBelongBusinessError } from "./vehicle-type-not-belong-business-error";

type ErrorClass = abstract new (...args: never[]) => Error;

/**
 * The vehicle-type routes' plain errors with an honest status and a code
 * (decision 11.3). Duplicates and "in use" are AppErrors (409) already.
 * Another company's type answers exactly like a missing one.
 */
const VEHICLE_TYPE_HTTP_ERRORS: ReadonlyArray<
  readonly [ErrorClass, number, string, string?]
> = [
  [BusinessNotFoundError, 404, "BUSINESS_NOT_FOUND"],
  [VehicleTypeNotFoundError, 404, "VEHICLE_TYPE_NOT_FOUND"],
  [
    VehicleTypeNotBelongBusinessError,
    404,
    "VEHICLE_TYPE_NOT_FOUND",
    "Tipo de veículo não encontrado!",
  ],
];

function replyVehicleTypeError(reply: FastifyReply, error: unknown): boolean {
  const entry = VEHICLE_TYPE_HTTP_ERRORS.find(
    ([type]) => error instanceof type,
  );

  if (!entry) return false;

  const [, status, code, message] = entry;

  reply
    .header("x-error-code", code)
    .status(status)
    .send({ code, message: message ?? (error as Error).message });

  return true;
}

export { replyVehicleTypeError, VEHICLE_TYPE_HTTP_ERRORS };
