class VehicleTypeNotFoundError extends Error {
  constructor() {
    super("Tipo de veículo não encontrado!");
  }
}

export { VehicleTypeNotFoundError };
