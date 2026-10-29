import { AppError } from "@/shared/errors/AppError";

class SupplierNotFoundError extends AppError {
  constructor() {
    super("Fornecedor não encontrado.", 404, "SUPPLIER_NOT_FOUND");
  }
}

export { SupplierNotFoundError };
