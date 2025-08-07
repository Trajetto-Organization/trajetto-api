class ResendTwoFactorError extends Error {
  constructor() {
    super(
      "O e-mail correspondente não possui uma verificação de duas etapas ativa!",
    );
  }
}

export { ResendTwoFactorError };
