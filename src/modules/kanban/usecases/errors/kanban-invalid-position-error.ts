import { AppError } from "@/shared/errors/AppError";

class KanbanInvalidPositionError extends AppError {
  constructor() {
    super("Posição inválida para reordenação.", 400, "KANBAN_INVALID_POSITION");
  }
}

export { KanbanInvalidPositionError };
