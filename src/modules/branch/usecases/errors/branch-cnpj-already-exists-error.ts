class BranchCnpjAlreadyExistsError extends Error {
  constructor() {
    super(
      "Este CNPJ não está disponível para cadastro. Os CNPJs de filiais devem ser únicos em todo o sistema.",
    );
  }
}

export { BranchCnpjAlreadyExistsError };
