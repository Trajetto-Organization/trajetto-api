class PermissionCannotBeDeletedByHimselfError extends Error {
  constructor() {
    super("Usuário não tem permissão para deletar a sua própria permissão");
  }
}

export { PermissionCannotBeDeletedByHimselfError };
