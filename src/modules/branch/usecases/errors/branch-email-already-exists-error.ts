class BranchEmailAlreadyExistsError extends Error {
  constructor() {
    super("Este e-mail já foi cadastrado em uma filial!");
  }
}

export { BranchEmailAlreadyExistsError };
