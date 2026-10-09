import { AppError } from "@/shared/errors/AppError";

/**
 * The CPF is unique per company (decision 8.1): an independent driver may
 * work for two carriers. The message speaks only of THIS company, so it
 * cannot tell anyone that the CPF exists at another one.
 */
class DriverCpfAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe um motorista com este CPF nesta empresa. Procure-o na listagem.",
      409,
      "DRIVER_CPF_ALREADY_EXISTS",
    );
  }
}

export { DriverCpfAlreadyExistsError };
