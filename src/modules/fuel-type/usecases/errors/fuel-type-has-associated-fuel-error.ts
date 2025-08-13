class FuelTypeHasAssociatedFuelError extends Error {
  constructor(fuelCount: number) {
    super(
      `Não é possível deletar este tipo de combustível pois existem ${fuelCount} registro(s) de combustível associado(s). ` +
        `\n\nOpções disponíveis:\n` +
        `• Alterar o tipo de combustível dos registros existentes (recomendado)\n` +
        `• Excluir registros de combustível antes de deletar o tipo`,
    );
  }
}

export { FuelTypeHasAssociatedFuelError };