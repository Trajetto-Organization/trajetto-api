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

/**
 * Another run is undoing this upload right now (it holds the lease and its
 * heartbeat is fresh). Two runs at once would race over the same rows and
 * announce the same deliveries twice. The HTTP route answers this case with
 * the 202 of the run already going; this is what the in-process callers get.
 */
class ImportReversalRunningError extends AppError {
  constructor() {
    super(
      "O estorno desta importação já está em andamento.",
      409,
      "IMPORT_REVERSAL_IN_PROGRESS",
    );
  }
}

/**
 * The run lost its lease: it went quiet long enough to be taken for dead and
 * another run took over. Its batch is rolled back rather than applied twice.
 * A 409 like the running case — the undo is someone else's now — should it
 * ever reach a client (in practice it ends a background run, and is logged).
 */
class ImportReversalLeaseLostError extends AppError {
  constructor() {
    super(
      "O estorno desta importação passou a ser feito por outra solicitação.",
      409,
      "IMPORT_REVERSAL_LEASE_LOST",
    );
  }
}

export {
  ImportAlreadyReversedError,
  ImportNotFoundError,
  ImportReversalLeaseLostError,
  ImportReversalRunningError,
};
