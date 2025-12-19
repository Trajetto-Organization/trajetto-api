class KanbanNotAllowedUpdateColumnBusinessError extends Error {
  constructor() {
    super("Você não tem permissão para editar colunas nesta empresa.");
  }
}

export { KanbanNotAllowedUpdateColumnBusinessError };
