class PermissionAlreadyExistsError extends Error {
  constructor() {
    super(
      "Já existe uma permissão com esse nome para este perfil! Para alterar, remova a permissão existente primeiro.",
    );
  }
}

export { PermissionAlreadyExistsError };
