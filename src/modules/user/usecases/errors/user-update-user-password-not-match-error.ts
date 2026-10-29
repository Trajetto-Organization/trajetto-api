import { AppError } from "@/shared/errors/AppError";

class UserUpdateUserPasswordNotMatchError extends AppError {
  constructor() {
    super("Senha atual incorreta", 400, "PASSWORD_CURRENT_INCORRECT");
  }
}

export { UserUpdateUserPasswordNotMatchError };
