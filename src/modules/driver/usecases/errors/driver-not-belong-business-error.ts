import { AppError } from "@/shared/errors/AppError";

/**
 * Another company's driver, answered exactly like a missing one (decision
 * 11.3): "não pertence a esta empresa" confirmed the id exists elsewhere.
 */
class DriverNotBelongBusinessError extends AppError {
  constructor() {
    super("Motorista não encontrado!", 404, "DRIVER_NOT_FOUND");
  }
}

export { DriverNotBelongBusinessError };
