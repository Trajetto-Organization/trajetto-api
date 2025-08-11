class FuelNotFoundError extends Error {
  constructor() {
    super("Registro de abastecimento não encontrado!");
  }
}

export { FuelNotFoundError };