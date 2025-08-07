class AccountPayableNotFoundError extends Error {
  constructor() {
    super("Conta a pagar não encontrada!");
  }
}

export { AccountPayableNotFoundError };
