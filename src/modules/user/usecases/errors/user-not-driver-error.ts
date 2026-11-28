import { AppError } from "@/shared/errors/AppError";

/**
 * A driver-only act on an office user's login (plan of 02/11/2026, D2/D3/D7):
 * a password set by the manager, an access QR code or the phone list. Office
 * users keep the single-use link of decision 4.9.
 */
class UserNotDriverError extends AppError {
  constructor() {
    super(
      "Esta ação vale só para o login de um motorista.",
      409,
      "USER_NOT_DRIVER",
    );
  }
}

export { UserNotDriverError };
