import type { FastifyReply } from "fastify";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleTypeNotFoundError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-found-error";
import { VehicleTypeNotBelongBusinessError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-belong-business-error";

import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";
import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { VehicleNotFoundError } from "./vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "./vehicle-not-belong-business-error";

import { VehicleModelYearError } from "./vehicle-model-year-error";
import { VehicleCurrentMileageCanNotBeUpdatedError } from "./vehicle-current-mileage-can-not-be-updated";
import { VehicleNotAssignedToDriverError } from "./vehicle-not-assigned-to-driver-error";
import { VehicleNoVehiclesToExportError } from "./vehicle-no-vehicles-to-export-error";

import { VehicleHasAssociatedFinesError } from "./vehicle-has-associated-fines-error";
import { VehicleHasAssociatedFuelError } from "./vehicle-has-associated-fuel-error";
import { VehicleHasAssociatedServiceOrdersError } from "./vehicle-has-associated-service-orders-error";
import { VehicleHasAssociatedChecklistsError } from "./vehicle-has-associated-checklists-error";
import { VehicleHasAssociatedOperationError } from "./vehicle-has-associated-operation-error";
import { VehicleHasAssociatedPayablesError } from "./vehicle-has-associated-payables-error";

type ErrorClass = abstract new (...args: never[]) => Error;

/**
 * The vehicle routes' domain errors, each with an honest status and a code
 * (decision 11.3): not found → 404, still referenced → 409, invalid input →
 * 400. Errors that are already AppErrors (duplicates, limits, status rules)
 * carry their own and reach the global handler untouched.
 *
 * A vehicle, vehicle type, fuel type, driver or branch of ANOTHER company
 * answers exactly like a missing one — status, code AND sentence: "não
 * pertence a esta empresa" confirmed the id existed somewhere else.
 */
const VEHICLE_HTTP_ERRORS: ReadonlyArray<
  readonly [ErrorClass, number, string, string?]
> = [
  [BusinessNotFoundError, 404, "BUSINESS_NOT_FOUND"],
  [VehicleNotFoundError, 404, "VEHICLE_NOT_FOUND"],
  [VehicleNotBelongBusinessError, 404, "VEHICLE_NOT_FOUND", "Veículo não encontrado!"],
  [VehicleNotAssignedToDriverError, 403, "VEHICLE_NOT_ASSIGNED_TO_DRIVER"],
  [VehicleTypeNotFoundError, 400, "VEHICLE_TYPE_NOT_FOUND"],
  [
    VehicleTypeNotBelongBusinessError,
    400,
    "VEHICLE_TYPE_NOT_FOUND",
    new VehicleTypeNotFoundError().message,
  ],
  [FuelTypeNotFoundError, 400, "FUEL_TYPE_NOT_FOUND"],
  [
    FuelTypeNotBelongBusinessError,
    400,
    "FUEL_TYPE_NOT_FOUND",
    new FuelTypeNotFoundError().message,
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
  [VehicleModelYearError, 400, "VEHICLE_MODEL_YEAR_INVALID"],
  [VehicleCurrentMileageCanNotBeUpdatedError, 400, "VEHICLE_MILEAGE_READ_ONLY"],
  [VehicleNoVehiclesToExportError, 400, "NOTHING_TO_EXPORT"],
  [VehicleHasAssociatedFinesError, 409, "VEHICLE_IN_USE"],
  [VehicleHasAssociatedFuelError, 409, "VEHICLE_IN_USE"],
  [VehicleHasAssociatedServiceOrdersError, 409, "VEHICLE_IN_USE"],
  [VehicleHasAssociatedChecklistsError, 409, "VEHICLE_IN_USE"],
  [VehicleHasAssociatedOperationError, 409, "VEHICLE_IN_USE"],
  [VehicleHasAssociatedPayablesError, 409, "VEHICLE_IN_USE"],
];

/**
 * Sends the mapped answer and returns true, or returns false for an error
 * this table does not know (the caller rethrows it).
 */
function replyVehicleError(reply: FastifyReply, error: unknown): boolean {
  const entry = VEHICLE_HTTP_ERRORS.find(([type]) => error instanceof type);

  if (!entry) return false;

  const [, status, code, message] = entry;

  reply
    .header("x-error-code", code)
    .status(status)
    .send({ code, message: message ?? (error as Error).message });

  return true;
}

export { replyVehicleError, VEHICLE_HTTP_ERRORS };
