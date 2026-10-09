import { AppError } from "@/shared/errors/AppError";

class UserInvalidTokenError extends AppError {
  constructor() {
    super("Token inválido!", 400, "AUTH_TOKEN_INVALID");
  }
}

export { UserInvalidTokenError };
