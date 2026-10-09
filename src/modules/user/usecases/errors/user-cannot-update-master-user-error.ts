import { AppError } from "@/shared/errors/AppError";
import { ACCESS_ERROR_CODES } from "@/shared/errors/access-errors";

// A refusal of the act itself: clients read it as "sem permissão" (decision 4.1).
class UserCannotUpdateMasterUserError extends AppError {
  constructor() {
    super("Apenas usuários Master podem atualizar outros usuários Master", 403, ACCESS_ERROR_CODES.PERMISSION_DENIED);
  }
}

export { UserCannotUpdateMasterUserError };
