class BranchDeletionCodeExpiredError extends Error {
  constructor() {
    super(
      "Código de confirmação expirado. Solicite a exclusão novamente para receber um novo código.",
    );
  }
}

export { BranchDeletionCodeExpiredError };
