class FuelNotBelongBusinessError extends Error {
  constructor() {
    super("Este registro de abastecimento não pertence a esta empresa!");
  }
}

export { FuelNotBelongBusinessError };