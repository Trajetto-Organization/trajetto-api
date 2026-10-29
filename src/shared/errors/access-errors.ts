import { AppError } from "./AppError";

/**
 * The three refusals a client must tell apart on a 403 (decision 4.1).
 *
 * The status alone cannot: a profile without the permission, a company that
 * never hired the module and a deactivated company all answer 403, and the
 * web read every one of them as "módulo não contratado". Each gets its own
 * code, raised only through the factories below, so no guard invents a
 * fourth spelling for the same case.
 */
const ACCESS_ERROR_CODES = {
  PERMISSION_DENIED: "PERMISSION_DENIED",
  MODULE_NOT_ENABLED: "MODULE_NOT_ENABLED",
  TENANT_INACTIVE: "TENANT_INACTIVE",
} as const;

type AccessErrorCode =
  (typeof ACCESS_ERROR_CODES)[keyof typeof ACCESS_ERROR_CODES];

function permissionDenied(message: string): AppError {
  return new AppError(message, 403, ACCESS_ERROR_CODES.PERMISSION_DENIED);
}

function moduleNotEnabled(message: string): AppError {
  return new AppError(message, 403, ACCESS_ERROR_CODES.MODULE_NOT_ENABLED);
}

function tenantInactive(message: string): AppError {
  return new AppError(message, 403, ACCESS_ERROR_CODES.TENANT_INACTIVE);
}

export {
  ACCESS_ERROR_CODES,
  moduleNotEnabled,
  permissionDenied,
  tenantInactive,
};
export type { AccessErrorCode };
