import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
class UserAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Este usuário não está disponível para cadastro. Use outro e-mail ou fale com o suporte.",
      409,
      "USER_ALREADY_EXISTS",
    );
  }
}

export { UserAlreadyExistsError };
