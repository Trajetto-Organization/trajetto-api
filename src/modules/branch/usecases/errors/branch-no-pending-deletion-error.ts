class BranchNoPendingDeletionError extends Error {
  constructor() {
    super(
      "Nenhuma solicitação de exclusão pendente. Solicite a exclusão novamente.",
    );
  }
}

export { BranchNoPendingDeletionError };
