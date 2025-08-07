class PartHasAssociatedServiceOrderPartsError extends Error {
  constructor(serviceOrderPartCount: number) {
    super(
      `Não é possível deletar esta peça pois ela está sendo utilizada em ${serviceOrderPartCount} ordem(ns) de serviço. ` +
        `\n\nOpções disponíveis:\n` +
        `• Substituir a peça nas ordens de serviço por outra peça (recomendado)\n` +
        `• Remover a peça das ordens de serviço antes de deletar\n` +
        `• Finalizar/cancelar as ordens de serviço que utilizam esta peça\n` +
        `• Inativar a peça ao invés de deletar`,
    );
  }
}

export { PartHasAssociatedServiceOrderPartsError };
