class UpdateUserPasswordNotMatchError extends Error {
  constructor() {
    super("Senha atual incorreta");
  }
}

export { UpdateUserPasswordNotMatchError };
