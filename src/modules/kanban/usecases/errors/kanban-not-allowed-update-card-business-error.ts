class KanbanNotAllowedUpdateCardBusinessError extends Error {
  constructor() {
    super("Você não tem permissão para editar cards nesta empresa.");
  }
}

export { KanbanNotAllowedUpdateCardBusinessError };
