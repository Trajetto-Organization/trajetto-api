class BranchDeletionCodeInvalidError extends Error {
  constructor() {
    super("Código de confirmação inválido. Verifique e tente novamente.");
  }
}

export { BranchDeletionCodeInvalidError };
