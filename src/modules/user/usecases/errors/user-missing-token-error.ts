class UserMissingTokenError extends Error {
  constructor() {
    super("Token ausente!");
  }
}

export { UserMissingTokenError };
