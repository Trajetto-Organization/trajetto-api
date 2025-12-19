class UserNotHaveAvatarToBeDeleted extends Error {
  constructor() {
    super("Usuário não possui avatar para ser deletado.");
  }
}

export { UserNotHaveAvatarToBeDeleted };
