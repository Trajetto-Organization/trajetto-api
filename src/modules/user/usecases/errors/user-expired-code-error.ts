class UserExpiredCodeError extends Error {
  constructor() {
    super("Código expirado!");
  }
}

export { UserExpiredCodeError };
