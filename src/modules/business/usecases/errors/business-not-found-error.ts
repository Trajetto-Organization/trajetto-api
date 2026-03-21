class BusinessNotFoundError extends Error {
  constructor() {
    super("Empresa não encontrada! Por favor, tente novamente.");
  }
}

export { BusinessNotFoundError };
