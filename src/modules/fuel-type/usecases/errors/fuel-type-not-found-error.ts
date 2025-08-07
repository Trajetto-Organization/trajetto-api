class FuelTypeNotFoundError extends Error {
  constructor() {
    super("Tipo de combustível não encontrado!");
  }
}

export { FuelTypeNotFoundError };
