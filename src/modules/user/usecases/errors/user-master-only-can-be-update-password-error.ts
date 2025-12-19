class UserMasterOnlyCanBeUpdatePasswordError extends Error {
  constructor() {
    super(
      "Apenas usuários com nível de acesso Master podem alterar senhas de outros usuários.",
    );
  }
}

export { UserMasterOnlyCanBeUpdatePasswordError };
