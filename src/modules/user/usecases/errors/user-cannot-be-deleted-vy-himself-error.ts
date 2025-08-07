class UserCannotBeDeletedByHimselfError extends Error {
  constructor() {
    super("Usuário não tem permissão para deletar o seu próprio usuário.");
  }
}

export { UserCannotBeDeletedByHimselfError };
