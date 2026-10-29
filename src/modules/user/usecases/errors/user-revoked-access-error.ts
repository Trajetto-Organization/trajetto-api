import { AppError } from "@/shared/errors/AppError";

class UserRevokedAccessError extends AppError {
  constructor() {
    super(
      "Seu acesso foi revogado! Para acessar a plataforma novamente, por favor contate o administrador.",
      403,
      "AUTH_ACCESS_REVOKED",
    );
  }
}

export { UserRevokedAccessError };
