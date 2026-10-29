import { AppError } from "@/shared/errors/AppError";

import type { ServiceOrderDeleteBlock } from "../../dtos/service-order-dto";

/**
 * Why a service order stays (FLEET-SO-1).
 *
 * A bill linked to the order would lose its origin: the foreign key is SET
 * NULL, so a paid bill ended up pointing at nothing. A finished order already
 * moved the vehicle's odometer and last maintenance, and deleting it does not
 * move them back. Both are refused with what is in the way, as vehicles and
 * drivers are.
 */
class ServiceOrderDeleteBlockedError extends AppError {
  constructor({ completed, accountsPayable }: ServiceOrderDeleteBlock) {
    const reasons = [
      accountsPayable > 0 &&
        `existem ${accountsPayable} conta(s) a pagar vinculada(s) a ela, que perderiam a origem`,
      completed &&
        "ela está concluída e já atualizou a quilometragem e a última manutenção do veículo, que não voltam com a exclusão",
    ].filter(Boolean);

    super(
      `Não é possível excluir esta ordem de serviço: ${reasons.join(" e ")}. ` +
        (accountsPayable > 0
          ? "Desvincule as contas a pagar antes, se a ordem foi lançada por engano."
          : "Para corrigir dados de uma ordem concluída, edite-a."),
      409,
      accountsPayable > 0
        ? "SERVICE_ORDER_HAS_ACCOUNTS_PAYABLE"
        : "SERVICE_ORDER_COMPLETED",
    );
  }
}

export { ServiceOrderDeleteBlockedError };
