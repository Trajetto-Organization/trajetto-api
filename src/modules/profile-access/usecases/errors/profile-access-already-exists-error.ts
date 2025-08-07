class ProfileAccessAlreadyExistsError extends Error {
  constructor() {
    super("Este perfil de acesso já existe para esta empresa!");
  }
}

export { ProfileAccessAlreadyExistsError };
