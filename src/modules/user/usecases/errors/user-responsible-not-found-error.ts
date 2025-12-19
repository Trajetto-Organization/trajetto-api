class UserResponsibleNotFoundError extends Error {
  constructor() {
    super("Usuário responsável não encontrado!");
  }
}

export { UserResponsibleNotFoundError };
