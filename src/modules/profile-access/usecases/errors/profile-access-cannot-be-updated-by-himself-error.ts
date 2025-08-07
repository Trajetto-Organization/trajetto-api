class ProfileAccessCannotBeUpdatedByHimselfError extends Error {
  constructor() {
    super(
      "Usuário não tem permissão para atualizar o seu próprio perfil de acesso.",
    );
  }
}

export { ProfileAccessCannotBeUpdatedByHimselfError };
