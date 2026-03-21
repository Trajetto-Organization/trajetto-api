class UserInvalidCredentialsError extends Error {
  constructor() {
    super("Credenciais inválidas!");
  }
}

export { UserInvalidCredentialsError };
