class VehicleNotFoundError extends Error {
  constructor() {
    super("Veículo não encontrado!");
  }
}

export { VehicleNotFoundError };
