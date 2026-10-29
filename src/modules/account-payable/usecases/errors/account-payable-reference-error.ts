import { AppError } from "@/shared/errors/AppError";

type AccountPayableReference =
  | "branch"
  | "serviceOrder"
  | "supplier"
  | "vehicle"
  | "responsible";

const MESSAGES: Record<AccountPayableReference, string> = {
  branch: "Filial não encontrada nesta empresa.",
  serviceOrder: "Ordem de serviço não encontrada nesta empresa.",
  supplier: "Fornecedor não encontrado nesta empresa.",
  vehicle: "Veículo não encontrado nesta empresa.",
  responsible: "Usuário responsável não encontrado nesta empresa.",
};

/**
 * A record the bill points at is missing OR of another company — the same
 * answer for both on purpose (decision 8.1): telling them apart would let a
 * caller learn that an id exists in another tenant.
 */
class AccountPayableReferenceError extends AppError {
  readonly reference: AccountPayableReference;

  constructor(reference: AccountPayableReference) {
    super(MESSAGES[reference], 400, "ACCOUNT_PAYABLE_INVALID_REFERENCE");

    this.reference = reference;
  }
}

export { AccountPayableReferenceError, type AccountPayableReference };
