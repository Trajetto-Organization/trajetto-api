class SupplierCnpjAlreadyExistsError extends Error {
  constructor() {
    super("Já existe um fornecedor com este CNPJ.");
  }
}

export { SupplierCnpjAlreadyExistsError };
