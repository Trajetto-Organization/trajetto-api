import { AppError } from "@/shared/errors/AppError";

class UserNotFoundPermissionOrProfileAccess extends AppError {
  constructor() {
    super(
      "Usuário sem perfil de acesso ou permissões configuradas! Por favor, contate o administrador.",
      403,
      "AUTH_PROFILE_NOT_CONFIGURED",
    );
  }
}

export { UserNotFoundPermissionOrProfileAccess };
