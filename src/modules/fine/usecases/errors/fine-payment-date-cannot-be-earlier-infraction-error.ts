class FinePaymentDateCannotBeEarlierInfractionError extends Error {
  constructor() {
    super("A data de pagamento não pode ser anterior à data da infração!");
  }
}

export { FinePaymentDateCannotBeEarlierInfractionError };
