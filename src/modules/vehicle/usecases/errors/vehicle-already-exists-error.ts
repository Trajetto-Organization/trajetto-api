import { AppError } from "@/shared/errors/AppError";

/**
 * The plate is taken IN THIS COMPANY. Plate and RENAVAM are unique per
 * company (decision 8.1), so the sentence can be direct: it is about the
 * caller's own fleet and says nothing about any other carrier.
 */
class VehicleAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe um veículo com esta placa nesta empresa. Procure-o na listagem de veículos.",
      409,
      "VEHICLE_PLATE_TAKEN",
    );
  }
}

export { VehicleAlreadyExistsError };
