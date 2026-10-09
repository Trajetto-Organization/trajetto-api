import { AppError } from "@/shared/errors/AppError";

/**
 * Another company's branch, answered exactly like a missing one (decision
 * 11.3): "não pertence a esta empresa" confirmed the id exists elsewhere.
 * Routes that name the branch in a body may still map it to 400.
 */
class BranchNotBelongBusinessError extends AppError {
  constructor() {
    super("Filial não encontrada.", 404, "BRANCH_NOT_FOUND");
  }
}

export { BranchNotBelongBusinessError };
