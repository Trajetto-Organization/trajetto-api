class UserRevokedAccessError extends Error {
  constructor() {
    super(
      "Seu acesso foi revogado! Para acessar a plataforma novamente, por favor contate o administrador.",
    );
  }
}

export { UserRevokedAccessError };
