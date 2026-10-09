import { AppError } from "@/shared/errors/AppError";

/** 409: records still point at the branch, so its state refuses the delete. */
class BranchHasChildrenError extends AppError {
  constructor(details: string) {
    super(
      `Não é possível excluir esta filial. ${details} Desative a filial ou remova os registros vinculados antes de excluí-la.`,
      409,
      "BRANCH_IN_USE",
    );
  }
}

export { BranchHasChildrenError };
