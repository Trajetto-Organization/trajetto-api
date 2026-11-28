import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
// Finishing an order does not free the user: a finished order keeps its
// responsible, so the options are only the two that do (batch of 14/11/2026).
class UserHasAssociatedServiceOrdersError extends AppError {
  constructor(serviceOrderCount: number) {
    super(
      `Não é possível excluir este usuário pois existem ${serviceOrderCount} ordem(ns) de serviço onde ele é responsável. ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir a responsabilidade das ordens de serviço para outro usuário\n` +
        `• Revogar o acesso dele: o login é encerrado e o histórico fica preservado\n`,
      409,
      "USER_HAS_SERVICE_ORDERS",
    );
  }
}

export { UserHasAssociatedServiceOrdersError };
