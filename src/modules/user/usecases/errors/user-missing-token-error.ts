import { AppError } from "@/shared/errors/AppError";

class UserMissingTokenError extends AppError {
  constructor() {
    super("Token ausente!", 400, "AUTH_TOKEN_MISSING");
  }
}

export { UserMissingTokenError };
