import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
class ProfileAccessNotFoundError extends AppError {
  constructor() {
    super("Perfil de acesso não encontrado!", 404, "PROFILE_ACCESS_NOT_FOUND");
  }
}

export { ProfileAccessNotFoundError };
