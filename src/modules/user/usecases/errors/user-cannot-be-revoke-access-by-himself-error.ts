class UserCannotBeRevokeByHimselfError extends Error {
  constructor() {
    super("Usuário não tem permissão para revogar o seu próprio acesso.");
  }
}

export { UserCannotBeRevokeByHimselfError };
