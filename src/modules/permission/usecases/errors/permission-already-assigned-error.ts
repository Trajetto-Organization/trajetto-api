class PermissionAlreadyAssignedError extends Error {
  constructor() {
    super("Esta permissão já está atribuída com este perfil.");
  }
}

export { PermissionAlreadyAssignedError };
