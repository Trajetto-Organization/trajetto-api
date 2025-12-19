class KanbanOneOrMoreColumnNotBelongBusinessError extends Error {
  constructor() {
    super("Uma ou mais colunas não pertencem a esta empresa.");
  }
}

export { KanbanOneOrMoreColumnNotBelongBusinessError };
