class UserCannotHaveBothDriverAndProfileError extends Error {
  constructor() {
    super(
      "Um usuário não pode ter tanto um perfil de acesso quanto um motorista vinculado. Escolha apenas um.",
    );
  }
}

export { UserCannotHaveBothDriverAndProfileError };
