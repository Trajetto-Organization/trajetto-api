class FuelDriverCannotDeleteFuelError extends Error {
  constructor() {
    super(
      "Motoristas não possuem permissão para deletar registros de abastecimento.",
    );
  }
}

export { FuelDriverCannotDeleteFuelError };
