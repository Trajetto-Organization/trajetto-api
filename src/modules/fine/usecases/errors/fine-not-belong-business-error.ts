class FineNotBelongBusinessError extends Error {
  constructor() {
    super("Esta multa não pertence a esta empresa!");
  }
}

export { FineNotBelongBusinessError };
