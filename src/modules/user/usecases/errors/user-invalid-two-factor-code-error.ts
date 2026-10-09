import { AppError } from "@/shared/errors/AppError";

class UserInvalidTwoFactorCodeError extends AppError {
  constructor() {
    super("Código inválido!", 400, "AUTH_2FA_CODE_INVALID");
  }
}

export { UserInvalidTwoFactorCodeError };
