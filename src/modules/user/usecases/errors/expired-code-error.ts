class ExpiredCodeError extends Error {
  constructor() {
    super("Código expirado!");
  }
}

export { ExpiredCodeError };
