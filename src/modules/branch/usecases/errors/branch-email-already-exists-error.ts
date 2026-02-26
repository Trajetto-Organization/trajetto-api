class BranchEmailAlreadyExistsError extends Error {
  constructor() {
    super(
      "Este e-mail não está disponível para cadastro. Os e-mails de filiais devem ser únicos em todo o sistema.",
    );
  }
}

export { BranchEmailAlreadyExistsError };
