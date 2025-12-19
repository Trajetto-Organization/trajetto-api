class FineNotFoundError extends Error {
  constructor() {
    super("Multa não encontrada!");
  }
}

export { FineNotFoundError };
