import { AppError } from "@/shared/errors/AppError";

/**
 * The driver's only tie is an app login (driverHistoryRefusal asks it last:
 * a driver who worked is told to deactivate instead). The login lives on the
 * Usuários screen, which the old sentence ("desvincule o usuário") never
 * named.
 */
export class DriverHasAssociatedUserError extends AppError {
  constructor() {
    super(
      "Este motorista tem um login do app. Exclua esse login na tela Usuários antes de excluir o motorista.",
      409,
      "DRIVER_HAS_USER",
    );
  }
}
