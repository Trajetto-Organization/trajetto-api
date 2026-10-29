import { AppError } from "@/shared/errors/AppError";

class AccountPayableInvalidAmountError extends AppError {
  constructor() {
    super(
      "O valor pago não pode ser maior que o valor total da conta!",
      400,
      "ACCOUNT_PAYABLE_INVALID_AMOUNT",
    );
  }
}

export { AccountPayableInvalidAmountError };
