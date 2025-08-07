class InvalidTokenError extends Error {
  constructor() {
    super("Token inválido!");
  }
}

export { InvalidTokenError };
