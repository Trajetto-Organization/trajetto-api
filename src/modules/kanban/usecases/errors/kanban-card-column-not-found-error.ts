import { AppError } from "@/shared/errors/AppError";

/** The card's column vanished between the two reads (a concurrent delete). */
class KanbanCardColumnNotFoundError extends AppError {
  constructor() {
    super("Coluna do card não encontrada.", 404, "KANBAN_COLUMN_NOT_FOUND");
  }
}

export { KanbanCardColumnNotFoundError };
