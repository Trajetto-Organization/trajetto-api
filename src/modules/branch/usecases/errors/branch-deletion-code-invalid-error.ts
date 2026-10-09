import { AppError } from "@/shared/errors/AppError";

class BranchDeletionCodeInvalidError extends AppError {
  constructor() {
    super(
      "Código de confirmação inválido. Verifique e tente novamente.",
      400,
      "BRANCH_DELETION_CODE_INVALID",
    );
  }
}

export { BranchDeletionCodeInvalidError };
