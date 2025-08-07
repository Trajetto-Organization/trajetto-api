class KanbanCardNotFoundError extends Error {
  constructor() {
    super("Card do kanban não encontrado.");
  }
}

export { KanbanCardNotFoundError };
