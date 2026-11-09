import { AppError } from "@/shared/errors/AppError";

/**
 * Creating a password without the current one is only for the session a QR
 * code opened, on that phone, within minutes of it (wave 2: "esqueci a
 * senha" without e-mail is a new QR from the manager, then the driver creates
 * the password at once). Anything else changes the password with the current
 * one (PATCH /user/password).
 */
class PasswordCreateNotAllowedError extends AppError {
  constructor() {
    super(
      "Criar a senha sem a senha atual só vale logo depois de entrar pelo QR Code, neste aparelho, em até 15 minutos. Peça um novo QR Code ao gestor ou troque a senha informando a senha atual.",
      403,
      "PASSWORD_CREATE_NOT_ALLOWED",
    );
  }
}

export { PasswordCreateNotAllowedError };
