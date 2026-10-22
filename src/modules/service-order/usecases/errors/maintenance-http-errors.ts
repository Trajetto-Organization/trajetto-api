import type { FastifyReply } from "fastify";

import { UserResponsibleNotFoundError } from "@/modules/user/usecases/errors/user-responsible-not-found-error";
import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";
import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";

import { ServiceOrderCompletionDateCannotBeEarlierOrderError } from "./service-order-completion-date-cannot-be-earlier-order-date-error";
import { ServiceOrderNewMileageRequireOrderFinalizedError } from "./service-order-new-mileage-require-order-finalized-error";
import { ServiceOrderRegistrationsMobileLocationRequiredError } from "./service-order-registrations-mobile-location-required-error";
import { ServiceOrderLocationNotProvidedAdjustmentValidationError } from "./service-order-location-not-provided-adjustment-validation-error";
import { ServiceOrderNoServiceOrdersToExportError } from "./service-order-no-service-orders-to-export-error";

type ErrorClass = abstract new (...args: never[]) => Error;

/** [error, status, code, message that replaces the error's own]. */
type MaintenanceHttpError = readonly [ErrorClass, number, string, string?];

/**
 * The sentences a foreign id borrows from its missing twin. The branch one is
 * the branch gate's (verifyBranchActive answers a missing branch before any
 * controller runs), so the master, who passes that gate, reads the same.
 */
const VEHICLE_NOT_FOUND = new VehicleNotFoundError().message;
const BRANCH_NOT_FOUND = "Filial não encontrada!";
const SUPPLIER_NOT_FOUND = new SupplierNotFoundError().message;
const RESPONSIBLE_NOT_FOUND = new UserResponsibleNotFoundError().message;

/**
 * The service-order, order-part and part routes' errors that are not
 * AppErrors already, or whose AppError status is wrong here — each with an
 * honest status and a code (decision 11.3), in the body and in
 * `x-error-code`.
 *
 * Another company's record answers exactly like one that exists nowhere:
 * the controllers used to say 403 "Este veículo não pertence a esta
 * empresa!" beside a 400 "Veículo não encontrado!", which told any manager
 * which ids exist in other companies. The order and the part named in the
 * PATH are 404 at the source (ServiceOrderNotFoundError, PartNotFoundError);
 * a link named in the BODY that does not resolve is a 400, as the vehicle
 * and fuel routes answer it — except the branch, which the branch gate
 * already answers 404.
 */
const MAINTENANCE_HTTP_ERRORS: ReadonlyArray<MaintenanceHttpError> = [
  [BusinessNotFoundError, 404, "BUSINESS_NOT_FOUND"],
  [VehicleNotFoundError, 400, "VEHICLE_NOT_FOUND"],
  [VehicleNotBelongBusinessError, 400, "VEHICLE_NOT_FOUND", VEHICLE_NOT_FOUND],
  [BranchNotFoundError, 404, "BRANCH_NOT_FOUND", BRANCH_NOT_FOUND],
  [BranchNotBelongBusinessError, 404, "BRANCH_NOT_FOUND", BRANCH_NOT_FOUND],
  [SupplierNotFoundError, 400, "SUPPLIER_NOT_FOUND"],
  [
    SupplierNotBelongBusinessError,
    400,
    "SUPPLIER_NOT_FOUND",
    SUPPLIER_NOT_FOUND,
  ],
  [UserResponsibleNotFoundError, 400, "RESPONSIBLE_USER_NOT_FOUND"],
  [
    UserNotBelongBusinessError,
    400,
    "RESPONSIBLE_USER_NOT_FOUND",
    RESPONSIBLE_NOT_FOUND,
  ],
  [
    ServiceOrderCompletionDateCannotBeEarlierOrderError,
    400,
    "SERVICE_ORDER_COMPLETION_BEFORE_DATE",
  ],
  [
    ServiceOrderNewMileageRequireOrderFinalizedError,
    400,
    "SERVICE_ORDER_MILEAGE_REQUIRED",
  ],
  [
    ServiceOrderRegistrationsMobileLocationRequiredError,
    400,
    "LOCATION_REQUIRED",
  ],
  [
    ServiceOrderLocationNotProvidedAdjustmentValidationError,
    400,
    "LOCATION_ORIGINAL_REQUIRED",
  ],
  // 400 like the vehicle, fuel and checklist exports: one code, one status.
  [ServiceOrderNoServiceOrdersToExportError, 400, "NOTHING_TO_EXPORT"],
];

/**
 * Sends the mapped answer and returns true, or returns false for an error
 * the table does not know (the caller rethrows it: AppErrors carry their own
 * status and code to the global handler).
 */
function replyMaintenanceError(reply: FastifyReply, error: unknown): boolean {
  const entry = MAINTENANCE_HTTP_ERRORS.find(([type]) => error instanceof type);

  if (!entry) return false;

  const [, status, code, message] = entry;

  reply
    .header("x-error-code", code)
    .status(status)
    .send({ code, message: message ?? (error as Error).message });

  return true;
}

export { MAINTENANCE_HTTP_ERRORS, replyMaintenanceError };
