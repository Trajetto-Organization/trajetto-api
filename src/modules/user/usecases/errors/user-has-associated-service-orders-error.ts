class UserHasAssociatedServiceOrdersError extends Error {
  constructor(serviceOrderCount: number) {
    super(
      `Não é possível deletar este usuário pois existem ${serviceOrderCount} ordem(ns) de serviço onde ele é responsável. ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir responsabilidade das ordens de serviço para outro usuário (recomendado)\n` +
        `• Finalizar/cancelar ordens de serviço pendentes antes de deletar\n`,
    );
  }
}

export { UserHasAssociatedServiceOrdersError };
