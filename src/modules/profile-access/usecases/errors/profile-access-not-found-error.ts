class ProfileAccessNotFoundError extends Error {
  constructor() {
    super("Perfil de acesso não encontrado!");
  }
}

export { ProfileAccessNotFoundError };
