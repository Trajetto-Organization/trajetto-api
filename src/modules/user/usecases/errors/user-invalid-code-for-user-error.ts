import { AppError } from "@/shared/errors/AppError";

class UserInvalidCodeForUserError extends AppError {
  constructor() {
    super("Código inválido para o usuário!", 400, "AUTH_2FA_USER_MISMATCH");
  }
}

export { UserInvalidCodeForUserError };
