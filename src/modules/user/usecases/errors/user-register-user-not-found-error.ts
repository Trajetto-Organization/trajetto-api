class UserRegisterUserNotFoundError extends Error {
  constructor() {
    super("Usuário de registro não encontrado!");
  }
}

export { UserRegisterUserNotFoundError };
