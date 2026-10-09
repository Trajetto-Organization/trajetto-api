import { AppError } from "@/shared/errors/AppError";

/**
 * Also the answer for another company's column: a 403 "not yours" would
 * confirm that the id exists on some other board (decision 11.3).
 */
class KanbanColumnNotFoundError extends AppError {
  constructor() {
    super("Coluna do kanban não encontrada.", 404, "KANBAN_COLUMN_NOT_FOUND");
  }
}

export { KanbanColumnNotFoundError };
