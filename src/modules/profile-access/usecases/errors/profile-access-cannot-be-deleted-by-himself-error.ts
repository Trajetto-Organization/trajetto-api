class ProfileAccessCannotBeDeletedByHimselfError extends Error {
  constructor() {
    super(
      "Usuário não tem permissão para deletar o seu próprio perfil de acesso.",
    );
  }
}

export { ProfileAccessCannotBeDeletedByHimselfError };
