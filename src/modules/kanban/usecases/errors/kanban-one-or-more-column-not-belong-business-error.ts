import { AppError } from "@/shared/errors/AppError";

/**
 * A board reorder naming a column that is missing or on another company's
 * board: one answer for both, so the batch is no existence probe.
 */
class KanbanOneOrMoreColumnNotBelongBusinessError extends AppError {
  constructor() {
    super(
      "Uma ou mais colunas não foram encontradas neste quadro.",
      404,
      "KANBAN_COLUMN_NOT_FOUND",
    );
  }
}

export { KanbanOneOrMoreColumnNotBelongBusinessError };
