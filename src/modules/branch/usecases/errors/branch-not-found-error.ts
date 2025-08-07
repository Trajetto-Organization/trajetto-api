class BranchNotFoundError extends Error {
  constructor() {
    super("Filial não encontrada.");
  }
}

export { BranchNotFoundError };
