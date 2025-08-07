class UserNameNotBeUpdatedError extends Error {
  constructor() {
    super("Para atualizar, o novo nome deve ser diferente do atual");
  }
}

export { UserNameNotBeUpdatedError };
