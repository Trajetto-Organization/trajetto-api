import { AppError } from "@/shared/errors/AppError";

class UserResendTwoFactorError extends AppError {
  constructor() {
    super(
      "O e-mail correspondente não possui uma verificação de duas etapas ativa!",
      400,
      "AUTH_2FA_NOT_ACTIVE",
    );
  }
}

export { UserResendTwoFactorError };
