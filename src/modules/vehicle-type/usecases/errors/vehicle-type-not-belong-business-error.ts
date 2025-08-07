class VehicleTypeNotBelongBusinessError extends Error {
  constructor() {
    super("Este tipo de veículo não pertence a esta empresa!");
  }
}

export { VehicleTypeNotBelongBusinessError };
