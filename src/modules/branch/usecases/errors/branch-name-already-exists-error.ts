class BranchNameAlreadyExistsError extends Error {
  constructor() {
    super(
      "Esta razão social não está disponível para cadastro. As razões sociais de filiais devem ser únicas em todo o sistema.",
    );
  }
}

export { BranchNameAlreadyExistsError };
