class SupplierEmailAlreadyExistsError extends Error {
  constructor() {
    super("Já existe um fornecedor com este e-mail.");
  }
}

export { SupplierEmailAlreadyExistsError };
