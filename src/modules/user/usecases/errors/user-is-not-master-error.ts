class UserIsNotMasterError extends Error {
  constructor() {
    super("O usuário informado não é um usuário Master.");
  }
}

export { UserIsNotMasterError };
