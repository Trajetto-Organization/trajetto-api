import { AppError } from "@/shared/errors/AppError";

/**
 * Also the answer for another company's branch: a 403 "not yours" would
 * confirm that the id exists somewhere else (decision 11.3).
 */
class BranchNotFoundError extends AppError {
  constructor() {
    super("Filial não encontrada.", 404, "BRANCH_NOT_FOUND");
  }
}

export { BranchNotFoundError };
