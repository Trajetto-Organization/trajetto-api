class BranchErpCodeAlreadyExistsError extends Error {
  constructor() {
    super(
      "Este código ERP não está disponível para cadastro. Os códigos ERP de filiais devem ser únicos em todo o sistema.",
    );
  }
}

export { BranchErpCodeAlreadyExistsError };
