import { AppError } from "@/shared/errors/AppError";

/**
 * "Aparelhos conectados" ends the person's OTHER sessions (wave 2). This
 * one's own way out is the logout, which also clears the device it runs on.
 */
class SessionIsCurrentError extends AppError {
  constructor() {
    super(
      "Esta é a sessão deste aparelho. Para encerrá-la, use Sair.",
      409,
      "SESSION_IS_CURRENT",
    );
  }
}

export { SessionIsCurrentError };
