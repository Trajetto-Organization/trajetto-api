import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
class UserAssignmentRequiredError extends AppError {
  constructor() {
    super(
      "Um usuário precisa de um perfil de acesso ou de um motorista vinculado. Selecione um dos dois.",
      400,
      "USER_ASSIGNMENT_REQUIRED",
    );
  }
}

export { UserAssignmentRequiredError };
