class UserExpiredTokenError extends Error {
  constructor() {
    super("Token expirado!");
  }
}

export { UserExpiredTokenError };
