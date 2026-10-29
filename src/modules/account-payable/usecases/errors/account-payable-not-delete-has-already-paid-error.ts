import { AppError } from "@/shared/errors/AppError";

/** A settled financial record stays: the state forbids it, hence 409. */
class AccountPayableNotDeleteHasAlreadyPaidError extends AppError {
  constructor() {
    super(
      "Não é possível excluir uma conta que já foi paga!",
      409,
      "ACCOUNT_PAYABLE_ALREADY_PAID",
    );
  }
}

export { AccountPayableNotDeleteHasAlreadyPaidError };
