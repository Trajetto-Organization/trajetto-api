class AccountPayableInvalidAmountError extends Error {
  constructor() {
    super("O valor pago não pode ser maior que o valor total da conta!");
  }
}

export { AccountPayableInvalidAmountError };
