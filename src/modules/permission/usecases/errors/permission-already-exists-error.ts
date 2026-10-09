import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
class PermissionAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe uma permissão com esse nome para este perfil! Para alterar, remova a permissão existente primeiro.",
      409,
      "PERMISSION_ALREADY_EXISTS",
    );
  }
}

export { PermissionAlreadyExistsError };
