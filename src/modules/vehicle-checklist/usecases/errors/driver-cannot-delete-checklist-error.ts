class DriverCannotDeleteChecklistError extends Error {
  constructor() {
    super(
      "Motoristas não possuem permissão para deletar registros de checklist veicular.",
    );
  }
}

export { DriverCannotDeleteChecklistError };
