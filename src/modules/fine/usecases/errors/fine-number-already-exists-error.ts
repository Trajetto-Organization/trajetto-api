class FineNumberAlreadyExistsError extends Error {
  constructor() {
    super("Já existe uma multa com este número!");
  }
}

export { FineNumberAlreadyExistsError };
