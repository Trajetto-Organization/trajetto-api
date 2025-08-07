class VehicleRenavamExistsError extends Error {
  constructor() {
    super(
      "Este renavam não está disponível para cadastro. O renavam de um veículo deve ser único em todo o sistema.",
    );
  }
}

export { VehicleRenavamExistsError };
