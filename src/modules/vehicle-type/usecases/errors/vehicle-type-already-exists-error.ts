import { AppError } from "@/shared/errors/AppError";

/** A type with this name already exists in THIS company (names are per company). */
class VehicleTypeAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe um tipo de veículo com este nome nesta empresa.",
      409,
      "VEHICLE_TYPE_NAME_TAKEN",
    );
  }
}

export { VehicleTypeAlreadyExistsError };
