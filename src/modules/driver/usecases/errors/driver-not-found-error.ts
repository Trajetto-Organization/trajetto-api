class DriverNotFoundError extends Error {
  constructor() {
    super("Motorista não encontrado!");
  }
}

export { DriverNotFoundError };
