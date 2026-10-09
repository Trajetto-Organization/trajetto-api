import { AppError } from "@/shared/errors/AppError";

class DriverNoDriversToExportError extends AppError {
  constructor() {
    // NOTHING_TO_EXPORT, the code of the other exports (decision 15.10).
    super("Não existem motoristas para exportar!", 400, "NOTHING_TO_EXPORT");
  }
}

export { DriverNoDriversToExportError };
