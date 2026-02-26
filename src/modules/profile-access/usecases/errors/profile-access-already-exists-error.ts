class ProfileAccessAlreadyExistsError extends Error {
  constructor() {
    super(
      "Este perfil não está disponível para cadastro. Já existe um perfil com este nome.",
    );
  }
}

export { ProfileAccessAlreadyExistsError };
