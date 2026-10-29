import { AppError } from "@/shared/errors/AppError";

/**
 * A card moved to another company's board. Only the MASTER can name both
 * ends; for anyone else the foreign end is simply not found.
 */
class KanbanCardCrossBoardMoveError extends AppError {
  constructor() {
    super(
      "Um card não pode ser movido para o quadro de outra empresa.",
      400,
      "KANBAN_CARD_CROSS_BOARD_MOVE",
    );
  }
}

export { KanbanCardCrossBoardMoveError };
