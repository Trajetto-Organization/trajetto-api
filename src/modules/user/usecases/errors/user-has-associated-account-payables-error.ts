import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
class UserHasAssociatedAccountPayablesError extends AppError {
  constructor(accountPayableCount: number) {
    super(
      `Não é possível deletar este usuário pois existem ${accountPayableCount} conta(s) a pagar onde ele é o responsável pelo registro. ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir responsabilidade das contas a pagar para outro usuário (recomendado)\n` +
        `• Quitar/cancelar contas pendentes antes de deletar\n`,
      409,
      "USER_HAS_ACCOUNT_PAYABLES",
    );
  }
}

export { UserHasAssociatedAccountPayablesError };
