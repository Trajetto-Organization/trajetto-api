import { AppError } from "@/shared/errors/AppError";

class UserNotBelongBusinessError extends AppError {
  constructor() {
    super(
      "Este usuário não pertence a esta empresa!",
      400,
      "USER_NOT_IN_BUSINESS",
    );
  }
}

export { UserNotBelongBusinessError };
