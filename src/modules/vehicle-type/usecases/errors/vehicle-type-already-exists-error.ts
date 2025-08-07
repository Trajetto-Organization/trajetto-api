class VehicleTypeAlreadyExistsError extends Error {
  constructor() {
    super("Este tipo de veículo já foi cadastrado para esta empresa!");
  }
}

export { VehicleTypeAlreadyExistsError };
