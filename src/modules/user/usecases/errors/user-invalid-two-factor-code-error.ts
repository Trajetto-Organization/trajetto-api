class UserInvalidTwoFactorCodeError extends Error {
  constructor() {
    super("Código inválido!");
  }
}

export { UserInvalidTwoFactorCodeError };
