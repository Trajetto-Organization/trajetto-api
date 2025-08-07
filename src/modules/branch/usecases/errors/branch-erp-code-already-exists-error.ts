class BranchErpCodeAlreadyExistsError extends Error {
  constructor() {
    super("Já existe uma filial com este código ERP.");
  }
}

export { BranchErpCodeAlreadyExistsError };
