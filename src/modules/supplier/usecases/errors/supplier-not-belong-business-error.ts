import { AppError } from "@/shared/errors/AppError";

/**
 * The supplier named in the path is not of the company named beside it. The
 * same answer for everyone, MASTER included: a supplier never changes
 * company, since its parts and service orders would point across tenants.
 */
class SupplierNotBelongBusinessError extends AppError {
  constructor() {
    super(
      "Este fornecedor não pertence a esta empresa!",
      403,
      "SUPPLIER_TENANT_MISMATCH",
    );
  }
}

export { SupplierNotBelongBusinessError };
