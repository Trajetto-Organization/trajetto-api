class UserCannotDeleteLastMasterError extends Error {
  constructor() {
    super(
      "Não é possível remover o último usuário Master do sistema. Deve existir pelo menos um.",
    );
  }
}

export { UserCannotDeleteLastMasterError };
