import { AppError } from "@/shared/errors/AppError";

/**
 * 404 with a code (decision 11.3). The read is scoped by company, so another
 * carrier's upload gets this same answer.
 */
class ImportNotFoundError extends AppError {
  constructor() {
    super(
      "Importação não encontrada! Por favor, tente novamente.",
      404,
      "IMPORT_NOT_FOUND",
    );
  }
}

/**
 * An import undone twice would report removing nothing and read like a
 * failure. Saying so plainly is what tells the operator the first click
 * worked.
 */
class ImportAlreadyReversedError extends AppError {
  constructor() {
    super("Esta importação já foi estornada.", 409, "IMPORT_ALREADY_REVERSED");
  }
}

export { ImportAlreadyReversedError, ImportNotFoundError };
