class KanbanColumnNotFoundError extends Error {
  constructor() {
    super("Coluna do kanban não encontrada.");
  }
}

export { KanbanColumnNotFoundError };
