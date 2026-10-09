import { AppError } from "@/shared/errors/AppError";

/**
 * The bill named in the path is not of the company named beside it — for the
 * MASTER too. The MASTER used to pass, and the update then rewrote the bill's
 * company, leaving its branch, supplier and vehicle in the old one.
 */
class AccountPayableNotNotBelongBusinessError extends AppError {
  constructor() {
    super(
      "Esta conta a pagar não pertence a esta empresa!",
      403,
      "ACCOUNT_PAYABLE_TENANT_MISMATCH",
    );
  }
}

export { AccountPayableNotNotBelongBusinessError };
