import { AppError } from "@/shared/errors/AppError";

class UserUpdateUserIsSamePasswordError extends AppError {
  constructor() {
    super(
      "A nova senha não pode ser igual à senha atual",
      400,
      "PASSWORD_SAME_AS_CURRENT",
    );
  }
}

export { UserUpdateUserIsSamePasswordError };
