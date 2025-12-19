class KanbanNotAllowedCreateColumnBusinessError extends Error {
  constructor() {
    super("Você não tem permissão para criar colunas nesta empresa.");
  }
}

export { KanbanNotAllowedCreateColumnBusinessError };
