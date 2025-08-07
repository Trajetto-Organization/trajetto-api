class VehicleHasAssociatedServiceOrdersError extends Error {
  constructor(serviceOrderCount: number) {
    super(
      `Não é possível deletar este veículo pois existem ${serviceOrderCount} ordem(ns) de serviço associada(s). ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir ordens de serviço para outro veículo (recomendado)\n` +
        `• Finalizar/cancelar ordens de serviço pendentes antes de deletar\n` +
        `• Manter histórico e inativar o veículo ao invés de deletar`,
    );
  }
}

export { VehicleHasAssociatedServiceOrdersError };
