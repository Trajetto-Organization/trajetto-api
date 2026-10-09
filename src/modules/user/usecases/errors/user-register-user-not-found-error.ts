import { AppError } from "@/shared/errors/AppError";

class UserRegisterUserNotFoundError extends AppError {
  constructor() {
    super("Usuário de registro não encontrado!", 404, "USER_NOT_FOUND");
  }
}

export { UserRegisterUserNotFoundError };
