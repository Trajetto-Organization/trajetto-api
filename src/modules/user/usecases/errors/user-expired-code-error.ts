import { AppError } from "@/shared/errors/AppError";

class UserExpiredCodeError extends AppError {
  constructor() {
    super("Código expirado!", 400, "AUTH_2FA_CODE_EXPIRED");
  }
}

export { UserExpiredCodeError };
