import { Prisma } from "@prisma/client";

import { BranchCnpjAlreadyExistsError } from "./branch-cnpj-already-exists-error";
import { BranchEmailAlreadyExistsError } from "./branch-email-already-exists-error";
import { BranchErpCodeAlreadyExistsError } from "./branch-erp-code-already-exists-error";
import { BranchNameAlreadyExistsError } from "./branch-name-already-exists-error";
import { uniqueTargetOf } from "@/shared/errors/prisma-error-meta";

type BranchConflict =
  | BranchCnpjAlreadyExistsError
  | BranchEmailAlreadyExistsError
  | BranchErpCodeAlreadyExistsError
  | BranchNameAlreadyExistsError;

/**
 * The 409 behind a unique violation of the branch table.
 *
 * The use cases look first and refuse with the same errors; this covers two
 * requests that both looked before either wrote. Without it the loser's
 * P2002 fell into the generic catch and answered 500.
 */
function branchUniqueViolation(error: unknown): BranchConflict | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return null;
  }

  const target = uniqueTargetOf(error);
  const fields = Array.isArray(target)
    ? target.join(",")
    : String(target ?? "");

  if (fields.includes("corporate_reason"))
    return new BranchNameAlreadyExistsError();
  if (fields.includes("email")) return new BranchEmailAlreadyExistsError();
  if (fields.includes("erp_code")) return new BranchErpCodeAlreadyExistsError();
  if (fields.includes("cnpj")) return new BranchCnpjAlreadyExistsError();

  return null;
}

export { branchUniqueViolation };
