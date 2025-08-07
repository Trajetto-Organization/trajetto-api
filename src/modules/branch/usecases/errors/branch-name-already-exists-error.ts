class BranchNameAlreadyExistsError extends Error {
  constructor() {
    super("Já existe uma filial cadastrada com esta razão social.");
  }
}

export { BranchNameAlreadyExistsError };
