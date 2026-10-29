import { AppError } from "@/shared/errors/AppError";

class ResourceNotFoundError extends AppError {
  constructor() {
    super("Recurso não encontrado!", 404, "USER_NOT_FOUND");
  }
}

export { ResourceNotFoundError };
