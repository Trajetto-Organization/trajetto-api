class SupplierEmailAlreadyExistsError extends Error {
  constructor() {
    super(
      "Este e-mail não está disponível para cadastro. Os e-mails de fornecedores devem ser únicos em todo o sistema.",
    );
  }
}

export { SupplierEmailAlreadyExistsError };
