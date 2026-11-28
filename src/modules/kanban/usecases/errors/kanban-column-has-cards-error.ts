import { AppError } from "@/shared/errors/AppError";

/**
 * A column that still holds cards is not deleted (decision D-38, 14/11/2026).
 * `kanban_card.columnId` is ON DELETE CASCADE, so the delete used to take
 * every card of the column with it — their history, the assignee, the work
 * of whoever moved them there — behind a dialog that only said it could not
 * be undone. Moving or deleting the cards first is a choice made card by
 * card.
 */
class KanbanColumnHasCardsError extends AppError {
  readonly cardsCount: number;

  constructor(cardsCount: number) {
    super(
      `A coluna tem ${cardsCount} cartão(ões). Mova ou exclua os cartões antes de excluir a coluna.`,
      409,
      "KANBAN_COLUMN_HAS_CARDS",
    );

    this.cardsCount = cardsCount;
  }
}

export { KanbanColumnHasCardsError };
