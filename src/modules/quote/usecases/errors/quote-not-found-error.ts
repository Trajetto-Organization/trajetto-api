class QuoteNotFoundError extends Error {
  constructor() {
    super("Orçamento não encontrado");
  }
}

export { QuoteNotFoundError };
