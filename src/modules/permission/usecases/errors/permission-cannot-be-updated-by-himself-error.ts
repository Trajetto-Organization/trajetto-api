class PermissionCannotBeUpdatedByHimselfError extends Error {
  constructor() {
    super("Usuário não tem permissão para atualizar a sua própria permissão");
  }
}

export { PermissionCannotBeUpdatedByHimselfError };
