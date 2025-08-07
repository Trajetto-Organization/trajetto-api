class VehicleAlreadyExistsError extends Error {
  constructor() {
    super(
      "Esta placa não está disponível para cadastro. As placas de veículos devem ser únicas em todo o sistema.",
    );
  }
}

export { VehicleAlreadyExistsError };
