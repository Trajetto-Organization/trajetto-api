class InvalidTwoFactorCodeError extends Error {
  constructor() {
    super("Código inválido!");
  }
}

export { InvalidTwoFactorCodeError };
