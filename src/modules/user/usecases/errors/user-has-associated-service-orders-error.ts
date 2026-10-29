import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
class UserHasAssociatedServiceOrdersError extends AppError {
  constructor(serviceOrderCount: number) {
    super(
      `Não é possível deletar este usuário pois existem ${serviceOrderCount} ordem(ns) de serviço onde ele é responsável. ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir responsabilidade das ordens de serviço para outro usuário (recomendado)\n` +
        `• Finalizar/cancelar ordens de serviço pendentes antes de deletar\n`,
      409,
      "USER_HAS_SERVICE_ORDERS",
    );
  }
}

export { UserHasAssociatedServiceOrdersError };
