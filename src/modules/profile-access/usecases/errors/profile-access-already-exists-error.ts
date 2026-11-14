import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
// The name is unique per company: the sentence says so and never speaks of
// another one.
class ProfileAccessAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe um perfil de acesso com este nome nesta empresa.",
      409,
      "PROFILE_ACCESS_ALREADY_EXISTS",
    );
  }
}

export { ProfileAccessAlreadyExistsError };
