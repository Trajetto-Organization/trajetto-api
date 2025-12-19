class RegisterUserNotFoundError extends Error {
  constructor() {
    super("Usuário de registro não encontrado!");
  }
}

export { RegisterUserNotFoundError };
