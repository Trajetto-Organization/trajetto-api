class FineDateInfractionCannotBeFutureError extends Error {
  constructor() {
    super("A data da infração não pode ser futura!");
  }
}

export { FineDateInfractionCannotBeFutureError };
