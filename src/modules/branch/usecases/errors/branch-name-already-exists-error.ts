import { AppError } from "@/shared/errors/AppError";

/**
 * The corporate name is unique per company (decision 8.1): two carriers may
 * both have a "Filial Campinas". The message speaks only of THIS company.
 */
class BranchNameAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe uma filial com esta razão social nesta empresa. Procure-a na listagem.",
      409,
      "BRANCH_NAME_TAKEN",
    );
  }
}

export { BranchNameAlreadyExistsError };
