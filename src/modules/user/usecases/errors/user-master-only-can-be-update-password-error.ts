import { AppError } from "@/shared/errors/AppError";
import { ACCESS_ERROR_CODES } from "@/shared/errors/access-errors";

// A refusal of the act itself: clients read it as "sem permissão" (decision 4.1).
class UserMasterOnlyCanBeUpdatePasswordError extends AppError {
  constructor() {
    super(
      "Apenas usuários com nível de acesso Master podem enviar o link de redefinição de senha a outro usuário.",
      403,
      ACCESS_ERROR_CODES.PERMISSION_DENIED,
    );
  }
}

export { UserMasterOnlyCanBeUpdatePasswordError };
