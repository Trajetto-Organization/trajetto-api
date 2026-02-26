class QuoteAlreadyFinalizedError extends Error {
  constructor() {
    super(
      "Não é possível atualizar orçamentos que já foram fechados ou convertidos.",
    );
  }
}

export { QuoteAlreadyFinalizedError };
