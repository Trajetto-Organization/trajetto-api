class PartAlreadyExistsError extends Error {
  constructor() {
    super(
      "Esta peça não está disponível para cadastro. Já existe uma peça com este nome.",
    );
  }
}

export { PartAlreadyExistsError };
