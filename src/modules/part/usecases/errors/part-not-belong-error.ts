class PartNotBelongError extends Error {
  constructor() {
    super("Esta peça não pertence a esta empresa!");
  }
}

export { PartNotBelongError };
