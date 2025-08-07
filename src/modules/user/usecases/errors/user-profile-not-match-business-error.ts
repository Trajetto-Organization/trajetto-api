class UserProfileNotMatchBusinessError extends Error {
  constructor() {
    super(
      "O perfil de acesso informado não pertence à mesma empresa do usuário.",
    );
  }
}

export { UserProfileNotMatchBusinessError };
