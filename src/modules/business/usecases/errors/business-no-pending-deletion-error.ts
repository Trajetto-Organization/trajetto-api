class BusinessNoPendingDeletionError extends Error {
  constructor() {
    super(
      "Nenhuma solicitação de exclusão pendente. Solicite a exclusão novamente.",
    );
  }
}

export { BusinessNoPendingDeletionError };
