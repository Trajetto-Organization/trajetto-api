class KanbanNotAllowedPermissionViewBusinessBoardError extends Error {
  constructor() {
    super("Você não tem permissão para visualizar o kanban nesta empresa.");
  }
}

export { KanbanNotAllowedPermissionViewBusinessBoardError };
