import type { FastifyReply, FastifyRequest } from "fastify";

import {
  anyPermissionDoc,
  decideAnyPermission,
  type PermissionAlternative,
  type PermissionPrincipal,
} from "@/modules/middlewares/verify-permission";
import type { AppError } from "@/shared/errors/AppError";

/**
 * Who may search vehicles, and how much of each one they get back
 * (DLV-COMBO-1, decision 4.7).
 *
 * The vehicle picker is also the "Atribuir motorista e veículo" combobox of
 * Entregas. A dispatcher holds `delivery_manage:write` and may not hold
 * `vehicle_manage:read`; the combobox then showed an error and the
 * assignment could not be made from the screen built for it. Such a
 * dispatcher is let in, and receives only what choosing a vehicle takes
 * (plate, description, status, responsible driver's name) — never the fleet
 * record (odometer, RENAVAM, maintenance).
 */
type VehiclePickerAccess = "fleet" | "choice";

/**
 * The fleet grant first: its refusal is the one a denied caller hears. Drivers
 * dispatch nothing: their app reaches their vehicles through the fleet grant
 * (the driver map holds vehicle_manage:read), scoped to them by the use case.
 */
const PICKER_ALTERNATIVES: readonly PermissionAlternative[] = [
  { key: "vehicle_manage", access: "read" },
  { key: "delivery_manage", access: "write", options: { allowDriver: false } },
];

function decideVehiclePickerAccess(
  principal: PermissionPrincipal,
): { access: VehiclePickerAccess } | { refusal: AppError } {
  const verdict = decideAnyPermission(principal, PICKER_ALTERNATIVES);

  if ("refusal" in verdict) return { refusal: verdict.refusal };

  return {
    access: verdict.granted.key === "vehicle_manage" ? "fleet" : "choice",
  };
}

/** The route guard, with what it decided left on the request for the controller. */
function verifyVehiclePickerAccess(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  const verdict = decideVehiclePickerAccess(
    request.user as PermissionPrincipal,
  );

  if ("refusal" in verdict) {
    done(verdict.refusal);
    return;
  }

  (
    request as FastifyRequest & { vehiclePickerAccess?: VehiclePickerAccess }
  ).vehiclePickerAccess = verdict.access;

  done();
}

// The OpenAPI transform documents both keys as alternatives
// (x-permissions-any), as for the driver picker (decision 4.7).
const vehiclePickerGuard = Object.assign(
  verifyVehiclePickerAccess,
  anyPermissionDoc(PICKER_ALTERNATIVES),
);

function vehiclePickerAccessOf(request: FastifyRequest): VehiclePickerAccess {
  return (
    (request as FastifyRequest & { vehiclePickerAccess?: VehiclePickerAccess })
      .vehiclePickerAccess ?? "choice"
  );
}

export { decideVehiclePickerAccess, vehiclePickerAccessOf, vehiclePickerGuard };
export type { VehiclePickerAccess };
