import { FastifyReply, FastifyRequest } from "fastify";

import {
  anyPermissionDoc,
  decideAnyPermission,
  type PermissionAlternative,
  type PermissionPrincipal,
} from "@/modules/middlewares/verify-permission";

/**
 * Who may list a company's drivers in a picker, and how much they see
 * (decision 4.7).
 *
 * The driver catalogue (`driver_manage:read`) sees the picker row as it
 * always did. A dispatcher (`delivery_manage:write`) assigns drivers to
 * routes without holding the catalogue: before, their "Atribuir motorista"
 * combobox answered 403 and they could not dispatch at all. They get the
 * `choice` projection — name, status and the licence facts the assignment
 * warns about — and never the documents.
 *
 * Driver tokens are refused on both paths: the driver map grants
 * `delivery_manage:write` for the app's own deliveries, which is no reason to
 * read the colleagues' list (decision 4.4).
 */
type DriverPickerAccess = "catalog" | "choice";

/** The catalogue first: its refusal is the one a denied caller hears. */
const PICKER_ALTERNATIVES: readonly PermissionAlternative[] = [
  { key: "driver_manage", access: "read", options: { allowDriver: false } },
  { key: "delivery_manage", access: "write", options: { allowDriver: false } },
];

function driverPickerAccess(
  principal: PermissionPrincipal,
): DriverPickerAccess | null {
  const verdict = decideAnyPermission(principal, PICKER_ALTERNATIVES);

  if ("refusal" in verdict) return null;

  return verdict.granted.key === "driver_manage" ? "catalog" : "choice";
}

/**
 * preHandler: lets either key through, refusing with the catalogue's own
 * refusal (the 403 PERMISSION_DENIED of verifyPermission) otherwise. Not
 * verifyAnyPermission itself: the controller asks again which key granted,
 * because that decides the projection.
 */
function verifyDriverPickerAccess(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: (err?: Error) => void,
) {
  const verdict = decideAnyPermission(
    request.user as PermissionPrincipal,
    PICKER_ALTERNATIVES,
  );

  done("refusal" in verdict ? verdict.refusal : undefined);
}

// The OpenAPI transform documents both keys as alternatives (x-permissions-any).
const verifyDriverPickerAccessHook = Object.assign(
  verifyDriverPickerAccess,
  anyPermissionDoc(PICKER_ALTERNATIVES),
);

export {
  driverPickerAccess,
  PICKER_ALTERNATIVES,
  verifyDriverPickerAccessHook as verifyDriverPickerAccess,
  type DriverPickerAccess,
};
