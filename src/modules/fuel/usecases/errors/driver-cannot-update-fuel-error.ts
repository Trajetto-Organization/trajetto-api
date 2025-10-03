class DriverCannotUpdateFuelError extends Error {
  constructor() {
    super(
      "Motoristas não possuem permissão para editar registros de abastecimento. Apenas criar novos.",
    );
  }
}

export { DriverCannotUpdateFuelError };
