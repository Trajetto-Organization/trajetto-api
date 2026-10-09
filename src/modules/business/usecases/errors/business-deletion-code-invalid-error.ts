import { AppError } from "@/shared/errors/AppError";

class BusinessDeletionCodeInvalidError extends AppError {
  constructor() {
    super(
      "Código de confirmação inválido. Verifique e tente novamente.",
      400,
      "BUSINESS_DELETION_CODE_INVALID",
    );
  }
}

export { BusinessDeletionCodeInvalidError };
