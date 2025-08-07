class UserHasAssociatedAccountPayablesError extends Error {
  constructor(accountPayableCount: number) {
    super(
      `Não é possível deletar este usuário pois existem ${accountPayableCount} conta(s) a pagar onde ele é o responsável pelo registro. ` +
        `\n\nOpções disponíveis:\n` +
        `• Transferir responsabilidade das contas a pagar para outro usuário (recomendado)\n` +
        `• Quitar/cancelar contas pendentes antes de deletar\n`,
    );
  }
}

export { UserHasAssociatedAccountPayablesError };
