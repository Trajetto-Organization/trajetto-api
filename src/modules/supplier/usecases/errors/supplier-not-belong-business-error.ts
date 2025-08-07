class SupplierNotBelongBusinessError extends Error {
  constructor() {
    super("Este fornecedor não pertence a esta empresa!");
  }
}

export { SupplierNotBelongBusinessError };
