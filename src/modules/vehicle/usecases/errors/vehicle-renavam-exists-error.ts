import { AppError } from "@/shared/errors/AppError";

/** RENAVAM taken in this company; see VehicleAlreadyExistsError. */
class VehicleRenavamExistsError extends AppError {
  constructor() {
    super(
      "Já existe um veículo com este RENAVAM nesta empresa. Procure-o na listagem de veículos.",
      409,
      "VEHICLE_RENAVAM_TAKEN",
    );
  }
}

export { VehicleRenavamExistsError };
