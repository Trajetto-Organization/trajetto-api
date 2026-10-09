import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
class UserIsNotMasterError extends AppError {
  constructor() {
    super("O usuário informado não é um usuário Master.", 404, "MASTER_USER_NOT_FOUND");
  }
}

export { UserIsNotMasterError };
