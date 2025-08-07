class ProfileAccessNotFoundError extends Error {
  constructor() {
    super("Perfil de acesso não encontrado! Por favor tente novamente.");
  }
}

export { ProfileAccessNotFoundError };
