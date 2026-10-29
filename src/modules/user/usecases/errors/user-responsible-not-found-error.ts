import { AppError } from "@/shared/errors/AppError";

class UserResponsibleNotFoundError extends AppError {
  constructor() {
    super(
      "Usuário responsável não encontrado!",
      400,
      "RESPONSIBLE_USER_NOT_FOUND",
    );
  }
}

export { UserResponsibleNotFoundError };
