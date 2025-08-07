class BranchCnpjAlreadyExistsError extends Error {
  constructor() {
    super("Já existe uma filial com este CNPJ.");
  }
}

export { BranchCnpjAlreadyExistsError };
