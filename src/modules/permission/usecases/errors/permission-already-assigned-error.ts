import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
class PermissionAlreadyAssignedError extends AppError {
  constructor() {
    super("Esta permissão já está atribuída com este perfil.", 409, "PERMISSION_ALREADY_ASSIGNED");
  }
}

export { PermissionAlreadyAssignedError };
