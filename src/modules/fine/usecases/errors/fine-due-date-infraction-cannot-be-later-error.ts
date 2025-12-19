class FineDueDateInfractionCannotBeLaterError extends Error {
  constructor() {
    super(
      "A nova data da infração não pode ser posterior à data de vencimento existente!",
    );
  }
}

export { FineDueDateInfractionCannotBeLaterError };
