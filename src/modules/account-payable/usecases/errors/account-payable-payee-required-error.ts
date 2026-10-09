import { AppError } from "@/shared/errors/AppError";

/**
 * An edit that would leave a bill without its payee (decision 8.4). Only a
 * bill that already names one: a legacy bill from before the column may be
 * edited without inventing a payee.
 */
class AccountPayablePayeeRequiredError extends AppError {
  constructor() {
    super(
      "Informe o favorecido: um fornecedor cadastrado ou um nome. Uma conta com favorecido não pode ficar sem ele.",
      400,
      "ACCOUNT_PAYABLE_PAYEE_REQUIRED",
    );
  }
}

export { AccountPayablePayeeRequiredError };
