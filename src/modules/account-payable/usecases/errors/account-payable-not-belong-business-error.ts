class AccountPayableNotNotBelongBusinessError extends Error {
  constructor() {
    super("Esta conta a pagar não pertence a esta empresa!");
  }
}

export { AccountPayableNotNotBelongBusinessError };
