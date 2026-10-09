import { AppError } from "@/shared/errors/AppError";

class UserExpiredTokenError extends AppError {
  constructor() {
    super("Token expirado!", 400, "AUTH_TOKEN_EXPIRED");
  }
}

export { UserExpiredTokenError };
