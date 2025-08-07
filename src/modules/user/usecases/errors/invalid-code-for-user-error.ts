class InvalidCodeForUserError extends Error {
  constructor() {
    super("Código inválido para o usuário!");
  }
}

export { InvalidCodeForUserError };
