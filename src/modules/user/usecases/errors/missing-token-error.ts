class MissingTokenError extends Error {
  constructor() {
    super("Token ausente!");
  }
}

export { MissingTokenError };
