import { AppError } from "@/shared/errors/AppError";

/**
 * The refusals of the pause routes, each with its own code (decision 11.3):
 * the app's outbox decides from the code whether an item is done, retried or
 * shown to the driver, so none of them may leave as a code-less 400.
 */

/**
 * Another pause of this driver is still open.
 *
 * Raised by the partial unique index driver_pause_one_open_idx, never by a
 * read before the insert: two taps, or two phones, race past any read.
 */
class PauseAlreadyOpenError extends AppError {
  constructor() {
    super(
      "Já existe uma pausa em andamento. Encerre-a antes de iniciar outra.",
      409,
      "PAUSE_ALREADY_OPEN",
    );
  }
}

/** The pause was already closed by another end gesture. */
class PauseAlreadyEndedError extends AppError {
  constructor() {
    super("Esta pausa já foi encerrada.", 409, "PAUSE_ALREADY_ENDED");
  }
}

/**
 * No pause with this start key in this company, and the end carried no start
 * to create it from. A key of another company is not seen at all; another
 * driver's pause of this company answers 409 SUBMISSION_OWNER_MISMATCH
 * instead (ADR 0006), never this.
 */
class PauseNotFoundError extends AppError {
  constructor() {
    super("Pausa não encontrada.", 404, "PAUSE_NOT_FOUND");
  }
}

/** The end key already closed ANOTHER pause: the app must mint a new one. */
class PauseSubmissionReusedError extends AppError {
  constructor() {
    super(
      "Este envio já encerrou outra pausa. Gere um novo envio e tente novamente.",
      409,
      "PAUSE_SUBMISSION_REUSED",
    );
  }
}

/**
 * A gesture tapped beyond the offline horizon (7 days, isOccurredAtStale)
 * that would create a pause. Its time is not trusted, and dating it by its
 * arrival would open NOW a pause the driver never started, holding the one
 * open slot and refusing the driver's real starts. Final for the outbox:
 * the item is dropped, not shown as a failure.
 */
class PauseTooOldError extends AppError {
  constructor() {
    super(
      "Esta pausa foi registrada há mais de 7 dias e não pode mais ser gravada.",
      409,
      "PAUSE_TOO_OLD",
    );
  }
}

/** The report's day range is inverted or longer than the ceiling. */
class PauseReportRangeError extends AppError {
  constructor(message: string) {
    super(message, 400, "PAUSE_REPORT_RANGE_INVALID");
  }
}

/**
 * Decision 14.4: a pause only exists inside a journey — a route of the
 * driver RELEASED or IN_PROGRESS that day, judged at the tap. Nothing is
 * written. Ending a pause that exists is never refused for this.
 */
class PauseRequiresRouteError extends AppError {
  constructor() {
    super(
      "Pausas só podem ser iniciadas durante uma rota liberada ou em andamento.",
      409,
      "PAUSE_REQUIRES_ROUTE",
    );
  }
}

/** The occurrence_type_id is not one of this company's types. */
class PauseTypeNotFoundError extends AppError {
  constructor() {
    super(
      "Tipo de pausa não encontrado! Por favor, tente novamente.",
      404,
      "OCCURRENCE_TYPE_NOT_FOUND",
    );
  }
}

/** The occurrence_type_id is a delivery or not-delivered type. */
class PauseTypeWrongCategoryError extends AppError {
  constructor() {
    super(
      "Este tipo não é um tipo de pausa. Escolha um tipo da categoria Pausa.",
      400,
      "OCCURRENCE_TYPE_WRONG_CATEGORY",
    );
  }
}

export {
  PauseRequiresRouteError,
  PauseTypeNotFoundError,
  PauseTypeWrongCategoryError,
  PauseAlreadyEndedError,
  PauseAlreadyOpenError,
  PauseNotFoundError,
  PauseReportRangeError,
  PauseSubmissionReusedError,
  PauseTooOldError,
};
