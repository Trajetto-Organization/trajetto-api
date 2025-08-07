class KanbanColumnNotBelongBusinessError extends Error {
  constructor() {
    super("Esta coluna não pertence a esta empresa!");
  }
}

export { KanbanColumnNotBelongBusinessError };
