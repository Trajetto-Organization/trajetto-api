class PermissionBusinessError extends Error {
  constructor() {
    super("O perfil de acesso não pertence a essa empresa.");
  }
}

export { PermissionBusinessError };
