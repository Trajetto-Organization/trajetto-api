class KanbanNotAllowedDeleteColumnBusinessError extends Error {
  constructor() {
    super("Você não tem permissão para deletar colunas nesta empresa.");
  }
}

export { KanbanNotAllowedDeleteColumnBusinessError };
