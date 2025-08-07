class PartAlreadyExistsError extends Error {
  constructor() {
    super("Esta peça já foi cadastrada para esta empresa!");
  }
}

export { PartAlreadyExistsError };
