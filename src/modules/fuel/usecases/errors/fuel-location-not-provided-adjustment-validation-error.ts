class FuelLocationNotProvidedAdjustmentValidationError extends Error {
  constructor() {
    super("Localização original não fornecida para validação de ajuste.");
  }
}

export { FuelLocationNotProvidedAdjustmentValidationError };
