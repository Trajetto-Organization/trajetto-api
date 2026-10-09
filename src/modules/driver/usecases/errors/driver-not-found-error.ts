import { AppError } from "@/shared/errors/AppError";

/**
 * 404 with a code (decision 11.3). A route that names the driver in a body
 * (a refueling, a checklist) maps it to 400: there the request is wrong.
 */
class DriverNotFoundError extends AppError {
  constructor() {
    super("Motorista não encontrado!", 404, "DRIVER_NOT_FOUND");
  }
}

export { DriverNotFoundError };
