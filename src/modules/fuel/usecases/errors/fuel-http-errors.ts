import type { FastifyReply } from "fastify";


import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";
import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { FuelNotFoundError } from "./fuel-not-found-error";
import { FuelVehicleInvalidStatusForFuelError } from "./fuel-vehicle-invalid-status-for-fuel-error";
import { FuelDriverCannotUpdateFuelError } from "./fuel-driver-cannot-update-fuel-error";
import { FuelDriverCannotDeleteFuelError } from "./fuel-driver-cannot-delete-fuel-error";
import { FuelLocationNotProvidedAdjustmentValidationError } from "./fuel-location-not-provided-adjustment-validation-error";
import { FuelRegistrationsMobileLocationRequiredError } from "./fuel-registrations-mobile-location-required-error";
import { FuelNoFuelsToExportError } from "./fuel-no-fuels-to-export-error";

type ErrorClass = abstract new (...args: never[]) => Error;

/** [error, status, code, message that replaces the error's own]. */
type FuelHttpError = readonly [ErrorClass, number, string, string?];

const VEHICLE_NOT_FOUND = "Veículo não encontrado!";

/**
 * The vehicle error says "above the vehicle's current mileage", which is the
 * rule for the newest refueling only: every refueling is placed by its date
 * first (fuel-rules.ts placeReading). Refusing a correction or a back-dated
 * refueling with that sentence told people the wrong rule.
 */
const FUEL_MILEAGE_INVALID =
  "A quilometragem não se encaixa no histórico do veículo: havendo registros em dias posteriores à data do abastecimento, ela precisa ficar entre a leitura anterior e a seguinte; no abastecimento mais recente, precisa superar a leitura anterior (e, se for novo, a quilometragem atual do veículo).";

/**
 * The fuel routes' domain errors, each with an honest status and a stable
 * code (decision 11.3), sent in the body and in `x-error-code` (the app's
 * queue reads the header).
 *
 * Another company's record answers exactly like a missing one — same
 * status, code and sentence. The controllers used to say "Este veículo não
 * pertence a esta empresa!" for a foreign id and "Veículo não encontrado!"
 * for an unknown one, which told any caller which ids exist elsewhere.
 */
const SHARED: FuelHttpError[] = [
  // A driver asking for a vehicle they may not operate (decision 8.2): the
  // code the vehicle and service-order routes answer for the same case.
  [VehicleNotAssignedToDriverError, 403, "VEHICLE_NOT_ASSIGNED_TO_DRIVER"],
];

/**
 * Create, update, delete and export. A link named in the BODY that does not resolve
 * is a 400 — the request is what is wrong; the refueling in the PATH is the
 * resource, so a missing one is a 404.
 *
 * The branch is the exception, and on purpose: the branch gate
 * (verifyBranchActive) answers a missing or foreign branch with 404
 * BRANCH_NOT_FOUND before the use case runs, and BranchNotFoundError is that
 * same 404 everywhere else. Answering 400 here gave the one code two
 * statuses — the MASTER, who passes the gate, got 400 where a manager got
 * 404.
 */
const FUEL_WRITE_ERRORS: FuelHttpError[] = [
  ...SHARED,
  [FuelNotFoundError, 404, "FUEL_NOT_FOUND"],
  [VehicleNotFoundError, 400, "VEHICLE_NOT_FOUND"],
  [VehicleNotBelongBusinessError, 400, "VEHICLE_NOT_FOUND", VEHICLE_NOT_FOUND],
  [DriverNotFoundError, 400, "DRIVER_NOT_FOUND"],
  [
    DriverNotBelongBusinessError,
    400,
    "DRIVER_NOT_FOUND",
    new DriverNotFoundError().message,
  ],
  [FuelTypeNotFoundError, 400, "FUEL_TYPE_NOT_FOUND"],
  [
    FuelTypeNotBelongBusinessError,
    400,
    "FUEL_TYPE_NOT_FOUND",
    new FuelTypeNotFoundError().message,
  ],
  [BranchNotFoundError, 404, "BRANCH_NOT_FOUND"],
  [
    BranchNotBelongBusinessError,
    404,
    "BRANCH_NOT_FOUND",
    new BranchNotFoundError().message,
  ],
  [
    VehicleMileageInvalidError,
    400,
    "VEHICLE_MILEAGE_INVALID",
    FUEL_MILEAGE_INVALID,
  ],
  [FuelVehicleInvalidStatusForFuelError, 400, "VEHICLE_NOT_FUELABLE"],
  [
    FuelLocationNotProvidedAdjustmentValidationError,
    400,
    "LOCATION_ORIGINAL_REQUIRED",
  ],
  [FuelRegistrationsMobileLocationRequiredError, 400, "LOCATION_REQUIRED"],
  [FuelDriverCannotUpdateFuelError, 403, "DRIVER_CANNOT_UPDATE_FUEL"],
  [FuelDriverCannotDeleteFuelError, 403, "DRIVER_CANNOT_DELETE_FUEL"],
  [FuelNoFuelsToExportError, 400, "NOTHING_TO_EXPORT"],
];

/** The list: only the caller can be missing (tenant refusals are AppErrors). */
const FUEL_LIST_ERRORS: FuelHttpError[] = SHARED;

/**
 * A vehicle's history (search-fuel-by-vehicle, get-previous-fuel): the
 * vehicle in the PATH is what is read, so missing or foreign is a 404.
 */
const FUEL_VEHICLE_READ_ERRORS: FuelHttpError[] = [
  ...SHARED,
  [VehicleNotFoundError, 404, "VEHICLE_NOT_FOUND"],
  [VehicleNotBelongBusinessError, 404, "VEHICLE_NOT_FOUND", VEHICLE_NOT_FOUND],
];

/**
 * Sends the entry of `table` that matches `error` — status, code in the body
 * and in `x-error-code`, and the replacement sentence when there is one —
 * and returns true; false for an error the table does not know.
 */
function replyFrom(
  table: FuelHttpError[],
  reply: FastifyReply,
  error: unknown,
): boolean {
  const entry = table.find(([type]) => error instanceof type);

  if (!entry) return false;

  const [, status, code, message] = entry;

  reply
    .header("x-error-code", code)
    .status(status)
    .send({ code, message: message ?? (error as Error).message });

  return true;
}

/**
 * Sends the mapped answer and returns true, or returns false for an error
 * the table does not know (the caller rethrows it to the error handler).
 */
function replyFuelWriteError(reply: FastifyReply, error: unknown): boolean {
  return replyFrom(FUEL_WRITE_ERRORS, reply, error);
}

function replyFuelVehicleReadError(
  reply: FastifyReply,
  error: unknown,
): boolean {
  return replyFrom(FUEL_VEHICLE_READ_ERRORS, reply, error);
}

function replyFuelListError(reply: FastifyReply, error: unknown): boolean {
  return replyFrom(FUEL_LIST_ERRORS, reply, error);
}

export {
  FUEL_MILEAGE_INVALID,
  FUEL_VEHICLE_READ_ERRORS,
  FUEL_WRITE_ERRORS,
  replyFrom,
  replyFuelListError,
  replyFuelVehicleReadError,
  replyFuelWriteError,
};
export type { FuelHttpError };
