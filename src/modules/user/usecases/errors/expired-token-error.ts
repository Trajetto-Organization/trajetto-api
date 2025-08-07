class ExpiredTokenError extends Error {
  constructor() {
    super("Token expirado!");
  }
}

export { ExpiredTokenError };
