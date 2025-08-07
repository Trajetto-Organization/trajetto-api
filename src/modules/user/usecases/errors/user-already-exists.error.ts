class UserAlreadyExistsError extends Error {
  constructor() {
    super("Este usuário já foi cadastrado!");
  }
}

export { UserAlreadyExistsError };
