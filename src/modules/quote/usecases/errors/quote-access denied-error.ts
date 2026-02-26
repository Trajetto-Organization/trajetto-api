class QuoteAccessDeniedError extends Error {
  constructor() {
    super("Acesso negado.");
  }
}

export { QuoteAccessDeniedError };
