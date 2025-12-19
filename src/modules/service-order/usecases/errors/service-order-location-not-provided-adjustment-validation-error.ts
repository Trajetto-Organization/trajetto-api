class ServiceOrderLocationNotProvidedAdjustmentValidationError extends Error {
  constructor() {
    super("Localização original não fornecida para validação de ajuste.");
  }
}

export { ServiceOrderLocationNotProvidedAdjustmentValidationError };
