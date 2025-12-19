class KanbanNotAllowedReorderCardBusinessError extends Error {
  constructor() {
    super("Você não tem permissão para reordenar os cards nesta empresa.");
  }
}

export { KanbanNotAllowedReorderCardBusinessError };
