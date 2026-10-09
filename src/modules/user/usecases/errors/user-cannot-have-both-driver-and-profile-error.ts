import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
class UserCannotHaveBothDriverAndProfileError extends AppError {
  constructor() {
    super(
      "Um usuário não pode ter tanto um perfil de acesso quanto um motorista vinculado. Escolha apenas um.",
      400,
      "USER_PROFILE_AND_DRIVER",
    );
  }
}

export { UserCannotHaveBothDriverAndProfileError };
