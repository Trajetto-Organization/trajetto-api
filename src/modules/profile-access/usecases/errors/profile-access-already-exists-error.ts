import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
class ProfileAccessAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Este perfil não está disponível para cadastro. Já existe um perfil com este nome.",
      409,
      "PROFILE_ACCESS_ALREADY_EXISTS",
    );
  }
}

export { ProfileAccessAlreadyExistsError };
