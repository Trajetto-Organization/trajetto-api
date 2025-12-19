class UserOnlyMasterBeAbleSetPasswordError extends Error {
  constructor() {
    super(
      "Apenas usuários com nível de acesso Master podem definir senhas personalizadas. A senha será gerada automaticamente.",
    );
  }
}

export { UserOnlyMasterBeAbleSetPasswordError };
