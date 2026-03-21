class UserCannotCreateMasterUserError extends Error {
  constructor() {
    super("Apenas usuários Master podem criar outros usuários Master.");
  }
}

export { UserCannotCreateMasterUserError };
