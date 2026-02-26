class FuelNotFoundError extends Error {
  constructor() {
    super(
      "Registro de abastecimento não encontrado ou não pertence a esta empresa.",
    );
  }
}

export { FuelNotFoundError };
