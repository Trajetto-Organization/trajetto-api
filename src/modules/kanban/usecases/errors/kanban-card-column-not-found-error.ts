class KanbanCardColumnNotFoundError extends Error {
  constructor() {
    super("Coluna do card não encontrada.");
  }
}

export { KanbanCardColumnNotFoundError };
