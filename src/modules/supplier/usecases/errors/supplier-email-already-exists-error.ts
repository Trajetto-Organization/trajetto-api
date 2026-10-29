import { AppError } from "@/shared/errors/AppError";

/**
 * Unique per company (decision 8.1). The e-mail used to be checked across
 * every company, which refused the second carrier of a shared workshop and
 * confirmed to it that the address existed in another tenant.
 */
class SupplierEmailAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe um fornecedor com este e-mail nesta empresa.",
      409,
      "SUPPLIER_EMAIL_TAKEN",
    );
  }
}

export { SupplierEmailAlreadyExistsError };
