class KanbanNotAllowedCreateCardBusinessError extends Error {
  constructor() {
    super("Você não tem permissão para criar cards nesta empresa.");
  }
}

export { KanbanNotAllowedCreateCardBusinessError };
