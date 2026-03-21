class UserInvalidCodeForUserError extends Error {
  constructor() {
    super("Código inválido para o usuário!");
  }
}

export { UserInvalidCodeForUserError };
