class FuelTypeNotBelongBusinessError extends Error {
  constructor() {
    super("Este tipo de combustível não pertence a esta empresa!");
  }
}

export { FuelTypeNotBelongBusinessError };
