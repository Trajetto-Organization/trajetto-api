class UserUpdateUserPasswordNotMatchError extends Error {
  constructor() {
    super("Senha atual incorreta");
  }
}

export { UserUpdateUserPasswordNotMatchError };
