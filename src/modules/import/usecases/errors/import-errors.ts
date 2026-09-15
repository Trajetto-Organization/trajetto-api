class ImportNotFoundError extends Error {
  constructor() {
    super("Importação não encontrada! Por favor, tente novamente.");
  }
}

/**
 * An import undone twice would report removing nothing and read like a
 * failure. Saying so plainly is what tells the operator the first click
 * worked.
 */
class ImportAlreadyReversedError extends Error {
  constructor() {
    super("Esta importação já foi estornada.");
  }
}

export { ImportAlreadyReversedError, ImportNotFoundError };
