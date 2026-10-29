import { AppError } from "@/shared/errors/AppError";
import { ACCESS_ERROR_CODES } from "@/shared/errors/access-errors";

/** Another company's board, named by its id in the path or body (decision 4.1). */
class KanbanNotAllowedReorderColumnBusinessError extends AppError {
  constructor() {
    super(
      "Você não tem permissão para reordenar as colunas nesta empresa.",
      403,
      ACCESS_ERROR_CODES.PERMISSION_DENIED,
    );
  }
}

export { KanbanNotAllowedReorderColumnBusinessError };
