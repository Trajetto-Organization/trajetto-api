import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error (decision 11.3), as the other
// catalogues' do: the module's HTTP table used to be the only place that
// knew this was a 409. Unique per company, so the sentence says so and never
// speaks of another one.
class FuelTypeAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe um tipo de combustível com este nome nesta empresa.",
      409,
      "FUEL_TYPE_ALREADY_EXISTS",
    );
  }
}

export { FuelTypeAlreadyExistsError };
