class UserInvalidTokenError extends Error {
  constructor() {
    super("Token inválido!");
  }
}

export { UserInvalidTokenError };
