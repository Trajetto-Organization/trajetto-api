class KanbanNotAllowedDeleteCardBusinessError extends Error {
  constructor() {
    super("Você não tem permissão para deletar cards nesta empresa.");
  }
}

export { KanbanNotAllowedDeleteCardBusinessError };
