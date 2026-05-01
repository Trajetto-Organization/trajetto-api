class BusinessDeletionCodeInvalidError extends Error {
  constructor() {
    super("Código de confirmação inválido. Verifique e tente novamente.");
  }
}

export { BusinessDeletionCodeInvalidError };
