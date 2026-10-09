import { AppError } from "@/shared/errors/AppError";

class UserNotHaveAvatarToBeDeleted extends AppError {
  constructor() {
    super("Usuário não possui avatar para ser deletado.", 404, "USER_AVATAR_NOT_FOUND");
  }
}

export { UserNotHaveAvatarToBeDeleted };
