import { AppError } from "@/shared/errors/AppError";

/**
 * Also the answer for another company's card: a 403 "not yours" would
 * confirm that the id exists on some other board (decision 11.3).
 */
class KanbanCardNotFoundError extends AppError {
  constructor() {
    super("Card do kanban não encontrado.", 404, "KANBAN_CARD_NOT_FOUND");
  }
}

export { KanbanCardNotFoundError };
