class UserCannotDeleteMasterUserError extends Error {
  constructor() {
    super("Apenas usuários Master podem remover outros usuários Master.");
  }
}

export { UserCannotDeleteMasterUserError };
