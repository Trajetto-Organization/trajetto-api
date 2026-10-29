import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
class PermissionNotFoundError extends AppError {
  constructor() {
    super("Permissão não encontrada!", 404, "PERMISSION_NOT_FOUND");
  }
}

export { PermissionNotFoundError };
