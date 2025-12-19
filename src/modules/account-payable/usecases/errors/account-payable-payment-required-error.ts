class AccountPayablePaymentRequiredError extends Error {
  constructor() {
    super(
      "É necessário informar um valor pago ao registrar uma data de pagamento!",
    );
  }
}

export { AccountPayablePaymentRequiredError };
