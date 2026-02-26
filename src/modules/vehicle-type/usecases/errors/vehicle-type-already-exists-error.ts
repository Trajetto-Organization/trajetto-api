class VehicleTypeAlreadyExistsError extends Error {
  constructor() {
    super(
      "Este tipo de veículo não está disponível para cadastro. Já existe um tipo de veículo com este nome.",
    );
  }
}

export { VehicleTypeAlreadyExistsError };
