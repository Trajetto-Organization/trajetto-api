class VehicleHasAssociatedFinesError extends Error {
  constructor(fineCount: number) {
    super(
      `Não é possível deletar este veículo pois existem ${fineCount} multa(s) associada(s). ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir multas para outro veículo (recomendado)\n` +
        `• Resolver/pagar multas pendentes antes de deletar`,
    );
  }
}

export { VehicleHasAssociatedFinesError };
