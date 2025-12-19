class KanbanNotAllowedReorderColumnBusinessError extends Error {
  constructor() {
    super("Você não tem permissão para reordenar as colunas nesta empresa.");
  }
}

export { KanbanNotAllowedReorderColumnBusinessError };
