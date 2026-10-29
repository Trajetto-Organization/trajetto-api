import type { FastifyReply } from "fastify";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";
import { VehicleMileageOutOfOrderError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-out-of-order-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { VehicleChecklistNotFoundError } from "./vehicle-checklist-not-found-error";
import { VehicleChecklistBusinessNotFoundError } from "./vehicle-checklist-business-not-found-error";
import { VehicleChecklistDriverCannotUpdateChecklistError } from "./vehicle-checklist-driver-cannot-update-checklist-error";
import { VehicleChecklistDriverCannotDeleteChecklistError } from "./vehicle-checklist-driver-cannot-delete-checklist-error";

type ErrorClass = abstract new (...args: never[]) => Error;

/** [error, status, code, message that replaces the error's own]. */
type ChecklistHttpError = readonly [ErrorClass, number, string, string?];

const CHECKLIST_NOT_FOUND = new VehicleChecklistNotFoundError().message;

/**
 * The checklist routes' domain errors, each with a status and a stable code
 * (decision 11.3), in the body and in `x-error-code` (the app's queue reads
 * the header).
 *
 * Another company's vehicle, driver, branch or checklist answers exactly like
 * an id that exists nowhere: the controllers said "Este veículo não pertence
 * a esta empresa!" for a foreign id and "Veículo não encontrado!" for an
 * unknown one, which told any caller which ids exist in another tenant
 * (decision 8.1). A link named in the BODY that does not resolve is a 400;
 * the checklist in the PATH is the resource, so a missing one is a 404.
 */
const CHECKLIST_HTTP_ERRORS: ReadonlyArray<ChecklistHttpError> = [
  [BusinessNotFoundError, 404, "BUSINESS_NOT_FOUND"],
  [VehicleChecklistNotFoundError, 404, "VEHICLE_CHECKLIST_NOT_FOUND"],
  [
    VehicleChecklistBusinessNotFoundError,
    404,
    "VEHICLE_CHECKLIST_NOT_FOUND",
    CHECKLIST_NOT_FOUND,
  ],
  [VehicleNotFoundError, 400, "VEHICLE_NOT_FOUND"],
  [
    VehicleNotBelongBusinessError,
    400,
    "VEHICLE_NOT_FOUND",
    new VehicleNotFoundError().message,
  ],
  [DriverNotFoundError, 400, "DRIVER_NOT_FOUND"],
  [
    DriverNotBelongBusinessError,
    400,
    "DRIVER_NOT_FOUND",
    new DriverNotFoundError().message,
  ],
  [BranchNotFoundError, 400, "BRANCH_NOT_FOUND"],
  [
    BranchNotBelongBusinessError,
    400,
    "BRANCH_NOT_FOUND",
    new BranchNotFoundError().message,
  ],
  // Before its parent class: the table answers the first entry that matches.
  // An edit whose km or date leaves the order of the records around it; the
  // message names the bounds (a date-only move used to be told "must be
  // greater than the vehicle's current mileage").
  [VehicleMileageOutOfOrderError, 400, "VEHICLE_MILEAGE_OUT_OF_ORDER"],
  [VehicleMileageInvalidError, 400, "VEHICLE_MILEAGE_INVALID"],
  // The same answer the vehicle, fuel and service-order routes give a driver
  // for a vehicle that is neither theirs nor their route's (decision 8.2).
  [VehicleNotAssignedToDriverError, 403, "VEHICLE_NOT_ASSIGNED_TO_DRIVER"],
  // Defence in depth behind verifyPermission(..., { allowDriver: false }):
  // a permission refusal, so the permission code (decision 4.1).
  [VehicleChecklistDriverCannotUpdateChecklistError, 403, "PERMISSION_DENIED"],
  [VehicleChecklistDriverCannotDeleteChecklistError, 403, "PERMISSION_DENIED"],
];

/**
 * Sends the mapped answer and returns true, or returns false for an error
 * the table does not know (the caller rethrows it to the error handler).
 */
function replyChecklistError(reply: FastifyReply, error: unknown): boolean {
  const entry = CHECKLIST_HTTP_ERRORS.find(([type]) => error instanceof type);

  if (!entry) return false;

  const [, status, code, message] = entry;

  reply
    .header("x-error-code", code)
    .status(status)
    .send({ code, message: message ?? (error as Error).message });

  return true;
}

export { CHECKLIST_HTTP_ERRORS, replyChecklistError };
