class KanbanCardNotBelongBusinessError extends Error {
  constructor() {
    super("Este card não pertence a esta empresa!");
  }
}

export { KanbanCardNotBelongBusinessError };
