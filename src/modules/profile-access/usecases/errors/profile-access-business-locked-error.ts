import { AppError } from "@/shared/errors/AppError";

// 409: the request is well formed, the profile's company simply cannot move.
class ProfileAccessBusinessLockedError extends AppError {
  constructor() {
    super(
      "Um perfil de acesso não muda de empresa. Para mover um usuário, edite o cadastro dele.",
      409,
      "PROFILE_ACCESS_BUSINESS_LOCKED",
    );
  }
}

export { ProfileAccessBusinessLockedError };
