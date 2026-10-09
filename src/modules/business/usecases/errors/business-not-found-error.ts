import { AppError } from "@/shared/errors/AppError";

/**
 * 404 with a code (decision 11.3). The company is the tenant named in the
 * path or the query, so a missing one is the resource missing, not a bad
 * request; every route answers it the same way through the global handler.
 */
class BusinessNotFoundError extends AppError {
  constructor() {
    super(
      "Empresa não encontrada! Por favor, tente novamente.",
      404,
      "BUSINESS_NOT_FOUND",
    );
  }
}

export { BusinessNotFoundError };
