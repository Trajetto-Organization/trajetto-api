class UserDriverAlreadyLinkedToUserError extends Error {
  constructor() {
    super("Este motorista já está vinculado a outro usuário.");
  }
}

export { UserDriverAlreadyLinkedToUserError };
