export class DriverAlreadyLinkedToUserError extends Error {
  constructor() {
    super("Este motorista já está vinculado a outro usuário.");
  }
}
