import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
class UserCannotDeleteLastMasterError extends AppError {
  constructor() {
    super(
      "Não é possível remover o último usuário Master do sistema. Deve existir pelo menos um.",
      409,
      "LAST_MASTER_USER",
    );
  }
}

export { UserCannotDeleteLastMasterError };
