import { AppError } from "@/shared/errors/AppError";
import { ACCESS_ERROR_CODES } from "@/shared/errors/access-errors";

// A refusal of the act itself: clients read it as "sem permissão" (decision 4.1).
class PermissionCannotBeDeletedByHimselfError extends AppError {
  constructor() {
    super(
      "Usuário não tem permissão para deletar a sua própria permissão",
      403,
      ACCESS_ERROR_CODES.PERMISSION_DENIED,
    );
  }
}

export { PermissionCannotBeDeletedByHimselfError };
