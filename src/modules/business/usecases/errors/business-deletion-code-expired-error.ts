import { AppError } from "@/shared/errors/AppError";

/** 400: the code was right but its window closed; a new request sends another. */
class BusinessDeletionCodeExpiredError extends AppError {
  constructor() {
    super(
      "Código de confirmação expirado. Solicite a exclusão novamente para receber um novo código.",
      400,
      "BUSINESS_DELETION_CODE_EXPIRED",
    );
  }
}

export { BusinessDeletionCodeExpiredError };
