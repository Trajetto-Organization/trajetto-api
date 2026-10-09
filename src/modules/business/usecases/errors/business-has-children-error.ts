import { AppError } from "@/shared/errors/AppError";

/** 409: records still point at the company, so its state refuses the delete. */
class BusinessHasChildrenError extends AppError {
  constructor(details: string) {
    super(
      `Não é possível excluir esta empresa. ${details} Desative a empresa ou remova os registros vinculados antes de excluí-la.`,
      409,
      "BUSINESS_IN_USE",
    );
  }
}

export { BusinessHasChildrenError };
