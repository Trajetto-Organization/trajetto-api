class SupplierNameAlreadyExistsError extends Error {
  constructor() {
    super(
      "Este nome não está disponível para cadastro. Já existe um fornecedor com este nome.",
    );
  }
}

export { SupplierNameAlreadyExistsError };
