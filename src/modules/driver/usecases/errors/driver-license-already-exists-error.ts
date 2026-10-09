import { AppError } from "@/shared/errors/AppError";

/** Same rule as the CPF: the CNH is unique per company (decision 8.1). */
class DriverLicenseAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe um motorista com esta CNH nesta empresa. Procure-o na listagem.",
      409,
      "DRIVER_CNH_ALREADY_EXISTS",
    );
  }
}

export { DriverLicenseAlreadyExistsError };
