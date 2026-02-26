class SupplierCnpjAlreadyExistsError extends Error {
  constructor() {
    super(
      "Este CNPJ não está disponível para cadastro. Já existe um fornecedor com este CNPJ.",
    );
  }
}

export { SupplierCnpjAlreadyExistsError };
