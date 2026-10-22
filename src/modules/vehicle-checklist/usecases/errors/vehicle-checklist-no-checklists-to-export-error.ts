import { AppError } from "@/shared/errors/AppError";

class VehicleChecklistNoChecklistsToExportError extends AppError {
  constructor() {
    super(
      "Não existem checklists veiculares para exportar!",
      400,
      "NOTHING_TO_EXPORT",
    );
  }
}

export { VehicleChecklistNoChecklistsToExportError };
