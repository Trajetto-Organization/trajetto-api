export class DriverHasAssociatedUserError extends Error {
  constructor() {
    super(
      "Este motorista possui um usuário vinculado. Desvincule o usuário antes de excluir o motorista.",
    );
  }
}
