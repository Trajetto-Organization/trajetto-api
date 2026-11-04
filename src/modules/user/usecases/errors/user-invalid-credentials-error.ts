import { AppError } from "@/shared/errors/AppError";

/**
 * Why a login was refused — for the log, never for the client.
 *
 * The client always gets the same sentence (anything else says which e-mails
 * exist). The reason and the user id travel with the error so the controller
 * can leave a forensic line (OBS-13): without them, a credential-stuffing run
 * left only "401 /user/session" behind.
 */
type InvalidCredentialsReason =
  | "unknown_email"
  | "wrong_password"
  | "account_locked"
  // The driver's login by CPF (plan of 02/11/2026, D8): no driver has the
  // CPF, or the company picked is not one where the password matched.
  | "unknown_cpf"
  | "company_not_matched";

class UserInvalidCredentialsError extends AppError {
  readonly reason?: InvalidCredentialsReason;
  readonly userId?: string;

  constructor(reason?: InvalidCredentialsReason, userId?: string) {
    super("Credenciais inválidas!", 401, "AUTH_INVALID_CREDENTIALS");

    this.reason = reason;
    this.userId = userId;
  }
}

export { UserInvalidCredentialsError, type InvalidCredentialsReason };
