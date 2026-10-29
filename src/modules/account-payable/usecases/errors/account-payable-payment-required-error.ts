import { AppError } from "@/shared/errors/AppError";

class AccountPayablePaymentRequiredError extends AppError {
  constructor() {
    super(
      "É necessário informar um valor pago ao registrar uma data de pagamento!",
      400,
      "ACCOUNT_PAYABLE_PAYMENT_REQUIRED",
    );
  }
}

export { AccountPayablePaymentRequiredError };
