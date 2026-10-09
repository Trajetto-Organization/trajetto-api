import { AppError } from "@/shared/errors/AppError";

/** The card kept changing column under a write; the board is being edited. */
class KanbanBoardChangedError extends AppError {
  constructor() {
    super(
      "O quadro mudou enquanto a alteração era feita. Atualize e tente novamente.",
      409,
      "KANBAN_BOARD_CHANGED",
    );
  }
}

export { KanbanBoardChangedError };
