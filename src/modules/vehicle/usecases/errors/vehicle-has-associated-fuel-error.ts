class VehicleHasAssociatedFuelError extends Error {
  constructor(fuelCount: number) {
    super(
      `Não é possível deletar este veículo pois existem ${fuelCount} registro(s) de abastecimento associado(s). ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir registros de combustível para outro veículo (recomendado)\n` +
        `• Excluir registros de combustível antes de deletar o veículo`,
    );
  }
}

export { VehicleHasAssociatedFuelError };
