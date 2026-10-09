import { AppError } from "@/shared/errors/AppError";

class UserNameNotBeUpdatedError extends AppError {
  constructor() {
    super("Para atualizar, o novo nome deve ser diferente do atual", 400, "USER_NAME_UNCHANGED");
  }
}

export { UserNameNotBeUpdatedError };
