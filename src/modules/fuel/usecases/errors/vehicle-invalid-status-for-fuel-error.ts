class VehicleInvalidStatusForFuelError extends Error {
  constructor() {
    super(
      "Não é possível abastecer um veículo que não esteja ativo ou em rota.",
    );
  }
}

export { VehicleInvalidStatusForFuelError };
