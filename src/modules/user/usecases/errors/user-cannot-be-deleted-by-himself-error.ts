import { AppError } from "@/shared/errors/AppError";
import { ACCESS_ERROR_CODES } from "@/shared/errors/access-errors";

// A refusal of the act itself: clients read it as "sem permissão" (decision 4.1).
class UserCannotBeDeletedByHimselfError extends AppError {
  constructor() {
    super("Usuário não tem permissão para deletar o seu próprio usuário.", 403, ACCESS_ERROR_CODES.PERMISSION_DENIED);
  }
}

export { UserCannotBeDeletedByHimselfError };
