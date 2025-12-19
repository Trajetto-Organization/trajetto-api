class AccountPayableNotDeleteHasAlreadyPaidError extends Error {
  constructor() {
    super("Não é possível excluir uma conta que já foi paga!");
  }
}

export { AccountPayableNotDeleteHasAlreadyPaidError };
