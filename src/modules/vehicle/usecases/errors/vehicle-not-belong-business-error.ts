class VehicleNotBelongBusinessError extends Error {
  constructor() {
    super("Este veículo não pertence a esta empresa!");
  }
}

export { VehicleNotBelongBusinessError };
