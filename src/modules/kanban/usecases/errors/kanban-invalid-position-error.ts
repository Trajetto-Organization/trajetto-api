class KanbanInvalidPositionError extends Error {
  constructor() {
    super("Posição inválida para reordenação.");
  }
}

export { KanbanInvalidPositionError };
