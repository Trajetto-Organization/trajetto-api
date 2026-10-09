import { AppError } from "@/shared/errors/AppError";

/** Unique per company, ignoring case. */
class SupplierNameAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe um fornecedor com este nome nesta empresa.",
      409,
      "SUPPLIER_NAME_TAKEN",
    );
  }
}

export { SupplierNameAlreadyExistsError };
