class UserResendTwoFactorError extends Error {
  constructor() {
    super(
      "O e-mail correspondente não possui uma verificação de duas etapas ativa!",
    );
  }
}

export { UserResendTwoFactorError };
