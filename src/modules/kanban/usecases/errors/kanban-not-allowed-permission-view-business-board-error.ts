class KanbanNotAllowedPermissionViewBusinessBoardError extends Error {
  constructor() {
    super("Você não tem permissão para visualizar o kanban desta empresa.");
  }
}

export { KanbanNotAllowedPermissionViewBusinessBoardError };
