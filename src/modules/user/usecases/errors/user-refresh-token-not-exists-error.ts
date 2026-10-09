import { AppError } from "@/shared/errors/AppError";

class UserRefreshTokenNotExistsError extends AppError {
  constructor() {
    super("O token de atualização não existe!", 401, "AUTH_REFRESH_INVALID");
  }
}

export { UserRefreshTokenNotExistsError };
