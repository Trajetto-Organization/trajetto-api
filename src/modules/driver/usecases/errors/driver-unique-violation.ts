import { Prisma } from "@prisma/client";

import { DriverCpfAlreadyExistsError } from "./driver-cpf-already-exists-error";
import { DriverLicenseAlreadyExistsError } from "./driver-license-already-exists-error";

/**
 * The 409 behind a unique violation of (businessId, cpf) or (businessId, cnh).
 *
 * The use cases look first and refuse with the same errors; this covers the
 * two requests that both looked before either wrote. Without it the loser's
 * P2002 fell into the generic catch and answered 500.
 */
function driverUniqueViolation(
  error: unknown,
): DriverCpfAlreadyExistsError | DriverLicenseAlreadyExistsError | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return null;
  }

  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target.join(",") : String(target ?? "");

  if (fields.includes("cpf")) return new DriverCpfAlreadyExistsError();
  if (fields.includes("cnh")) return new DriverLicenseAlreadyExistsError();

  return null;
}

export { driverUniqueViolation };
