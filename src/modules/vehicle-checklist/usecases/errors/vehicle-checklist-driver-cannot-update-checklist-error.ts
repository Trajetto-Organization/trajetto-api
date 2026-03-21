class VehicleChecklistDriverCannotUpdateChecklistError extends Error {
  constructor() {
    super(
      "Motoristas não possuem permissão para editar registros de checklist veicular. Apenas criar novos.",
    );
  }
}

export { VehicleChecklistDriverCannotUpdateChecklistError };
