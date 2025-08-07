class FuelTypeHasAssociatedVehiclesError extends Error {
  constructor(vehicleCount: number) {
    super(
      `Não é possível deletar este tipo de combustível pois existem ${vehicleCount} veículo(s) associado(s). ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir veículos para outro tipo de combustível (recomendado)\n` +
        `• Atualizar os veículos individualmente antes de deletar este tipo de combustível`,
    );
  }
}

export { FuelTypeHasAssociatedVehiclesError };
