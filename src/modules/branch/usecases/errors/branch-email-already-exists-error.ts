import { AppError } from "@/shared/errors/AppError";

/**
 * The e-mail is unique per company (decision 8.1): a shared mailbox may serve
 * branches of two carriers. The message speaks only of THIS company.
 */
class BranchEmailAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe uma filial com este e-mail nesta empresa. Use outro e-mail.",
      409,
      "BRANCH_EMAIL_TAKEN",
    );
  }
}

export { BranchEmailAlreadyExistsError };
