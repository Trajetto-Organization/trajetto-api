import { AppError } from "@/shared/errors/AppError";

/**
 * Companies are the platform's own tenants, registered by the MASTER: their
 * identity fields are unique across the platform. A conflict is a 409.
 */
class BusinessEmailAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe uma empresa com este e-mail.",
      409,
      "BUSINESS_EMAIL_TAKEN",
    );
  }
}

export { BusinessEmailAlreadyExistsError };
