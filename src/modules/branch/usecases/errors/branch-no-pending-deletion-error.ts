import { AppError } from "@/shared/errors/AppError";

/**
 * 409 (decision 11.3): the confirmation is well formed, but there is no
 * deletion request for it to confirm — the state refuses it, not the input.
 */
class BranchNoPendingDeletionError extends AppError {
  constructor() {
    super(
      "Nenhuma solicitação de exclusão pendente. Solicite a exclusão novamente.",
      409,
      "BRANCH_DELETION_NOT_REQUESTED",
    );
  }
}

export { BranchNoPendingDeletionError };
