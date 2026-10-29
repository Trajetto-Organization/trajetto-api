import { AppError } from "@/shared/errors/AppError";

/**
 * Companies are the platform's own tenants, registered by the MASTER: their
 * identity fields are unique across the platform. A conflict is a 409.
 */
class BusinessCnpjAlreadyExistsError extends AppError {
  constructor() {
    super("Já existe uma empresa com este CNPJ.", 409, "BUSINESS_CNPJ_TAKEN");
  }
}

export { BusinessCnpjAlreadyExistsError };
