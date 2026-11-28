import { AppError } from "@/shared/errors/AppError";

// Status and code travel with the error, so every route answers it alike (decision 11.3).
// Paying a bill does not free the user: a paid bill keeps who registered it,
// so the options are only the two that do (batch of 14/11/2026).
class UserHasAssociatedAccountPayablesError extends AppError {
  constructor(accountPayableCount: number) {
    super(
      `Não é possível excluir este usuário pois existem ${accountPayableCount} conta(s) a pagar onde ele é o responsável pelo registro. ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir a responsabilidade das contas a pagar para outro usuário\n` +
        `• Revogar o acesso dele: o login é encerrado e o histórico fica preservado\n`,
      409,
      "USER_HAS_ACCOUNT_PAYABLES",
    );
  }
}

export { UserHasAssociatedAccountPayablesError };
