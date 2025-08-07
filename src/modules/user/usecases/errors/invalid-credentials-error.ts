class InvalidCredentialsError extends Error {
  constructor() {
    super("Credenciais inválidas!");
  }
}

export { InvalidCredentialsError };
