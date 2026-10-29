import { AppError } from "@/shared/errors/AppError";

class UserAssignedUserNotFoundError extends AppError {
  constructor() {
    super("Usuário atribuído não encontrado.", 400, "ASSIGNED_USER_NOT_FOUND");
  }
}

export { UserAssignedUserNotFoundError };
