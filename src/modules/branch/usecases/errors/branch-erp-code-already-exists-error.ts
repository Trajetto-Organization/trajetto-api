import { AppError } from "@/shared/errors/AppError";

/** The ERP code is the carrier's own numbering: unique inside one company. */
class BranchErpCodeAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe uma filial da sua empresa com este código ERP.",
      409,
      "BRANCH_ERP_CODE_TAKEN",
    );
  }
}

export { BranchErpCodeAlreadyExistsError };
