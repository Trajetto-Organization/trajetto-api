class FineDueDateMustBeAfterInfractionError extends Error {
  constructor() {
    super("A data de vencimento deve ser posterior à data da infração!");
  }
}

export { FineDueDateMustBeAfterInfractionError };
