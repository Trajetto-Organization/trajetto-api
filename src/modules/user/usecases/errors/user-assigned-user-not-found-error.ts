class UserAssignedUserNotFoundError extends Error {
  constructor() {
    super("Usuário atribuído não encontrado.");
  }
}

export { UserAssignedUserNotFoundError };
