import { Prisma } from "@prisma/client";

import { BusinessCnpjAlreadyExistsError } from "./business-cnpj-already-exists-error";
import { BusinessCorporateReasonAlreadyExistsError } from "./business-corporate-reason-already-exists-error";
import { BusinessEmailAlreadyExistsError } from "./business-email-already-exists-error";
import { BusinessErpCodeAlreadyExistsError } from "./business-erp-code-already-exists-error";

type BusinessConflict =
  | BusinessCnpjAlreadyExistsError
  | BusinessCorporateReasonAlreadyExistsError
  | BusinessEmailAlreadyExistsError
  | BusinessErpCodeAlreadyExistsError;

/**
 * The 409 behind a unique violation of the business table.
 *
 * The use cases look first; this covers two saves that both looked before
 * either wrote. Without it the loser's P2002 fell into the generic catch and
 * answered 500 for what is a plain conflict.
 */
function businessUniqueViolation(error: unknown): BusinessConflict | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return null;
  }

  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target.join(",") : String(target ?? "");

  if (fields.includes("corporate_reason")) return new BusinessCorporateReasonAlreadyExistsError();
  if (fields.includes("email")) return new BusinessEmailAlreadyExistsError();
  if (fields.includes("erp_code")) return new BusinessErpCodeAlreadyExistsError();
  if (fields.includes("cnpj")) return new BusinessCnpjAlreadyExistsError();

  return null;
}

export { businessUniqueViolation };
