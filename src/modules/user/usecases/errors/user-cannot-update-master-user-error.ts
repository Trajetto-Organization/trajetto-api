class UserCannotUpdateMasterUserError extends Error {
  constructor() {
    super("Apenas usuários Master podem atualizar outros usuários Master");
  }
}

export { UserCannotUpdateMasterUserError };
