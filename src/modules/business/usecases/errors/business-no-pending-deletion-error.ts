import { AppError } from "@/shared/errors/AppError";

/**
 * 409 (decision 11.3): the confirmation is well formed, but there is no
 * deletion request for it to confirm — the state refuses it, not the input.
 */
class BusinessNoPendingDeletionError extends AppError {
  constructor() {
    super(
      "Nenhuma solicitação de exclusão pendente. Solicite a exclusão novamente.",
      409,
      "BUSINESS_DELETION_NOT_REQUESTED",
    );
  }
}

export { BusinessNoPendingDeletionError };
