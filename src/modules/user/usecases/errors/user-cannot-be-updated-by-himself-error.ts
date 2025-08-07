class UserCannotBeUpdatedByHimselfError extends Error {
  constructor() {
    super("Usuário não tem permissão para atualizar o seu próprio usuário.");
  }
}

export { UserCannotBeUpdatedByHimselfError };
