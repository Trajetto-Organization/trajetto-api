import { AppError } from "@/shared/errors/AppError";

/** 409; the count rides along so the web can say how many people hold it. */
class ProfileAccessInUseError extends AppError {
  constructor(readonly usersCount: number) {
    super(
      usersCount === 1
        ? "Este perfil de acesso está em uso por 1 usuário. Troque o perfil dele antes de excluir."
        : `Este perfil de acesso está em uso por ${usersCount} usuários. Troque o perfil deles antes de excluir.`,
      409,
      "PROFILE_ACCESS_IN_USE",
    );
  }
}

export { ProfileAccessInUseError };
