class SupplierNotFoundError extends Error {
  constructor() {
    super("Fornecedor não encontrado.");
  }
}

export { SupplierNotFoundError };
