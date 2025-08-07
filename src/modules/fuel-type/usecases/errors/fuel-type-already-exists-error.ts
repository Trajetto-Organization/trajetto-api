class FuelTypeAlreadyExistsError extends Error {
  constructor() {
    super("Este tipo de combustível já foi cadastrado para esta empresa!");
  }
}

export { FuelTypeAlreadyExistsError };
