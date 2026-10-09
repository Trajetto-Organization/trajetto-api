import { AppError } from "@/shared/errors/AppError";

/** Unique per company (decision 8.1): says nothing about other companies. */
class SupplierCnpjAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe um fornecedor com este CNPJ nesta empresa.",
      409,
      "SUPPLIER_CNPJ_TAKEN",
    );
  }
}

export { SupplierCnpjAlreadyExistsError };
