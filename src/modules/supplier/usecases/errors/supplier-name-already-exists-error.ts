class SupplierNameAlreadyExistsError extends Error {
  constructor() {
    super("Já existe um fornecedor com este nome para esta empresa.");
  }
}

export { SupplierNameAlreadyExistsError };
