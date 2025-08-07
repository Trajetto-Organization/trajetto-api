class PartNotFoundError extends Error {
  constructor() {
    super("Peça não encontrada!");
  }
}

export { PartNotFoundError };
