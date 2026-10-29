import { AppError } from "@/shared/errors/AppError";

class AccountPayableNotFoundError extends AppError {
  constructor() {
    super("Conta a pagar não encontrada!", 404, "ACCOUNT_PAYABLE_NOT_FOUND");
  }
}

export { AccountPayableNotFoundError };
