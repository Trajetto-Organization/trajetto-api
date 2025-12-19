class FineDueDateMustBeLaterInfractionError extends Error {
  constructor() {
    super(
      "A nova data de vencimento deve ser posterior à data da infração existente!",
    );
  }
}

export { FineDueDateMustBeLaterInfractionError };
