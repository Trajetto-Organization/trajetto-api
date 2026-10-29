import { AppError } from "@/shared/errors/AppError";

export class DriverHasAssociatedUserError extends AppError {
  constructor() {
    super(
      "Este motorista possui um usuário vinculado. Desvincule o usuário antes de excluir o motorista.",
      409,
      "DRIVER_HAS_USER",
    );
  }
}
