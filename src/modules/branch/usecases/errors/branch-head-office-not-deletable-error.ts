import { AppError } from "@/shared/errors/AppError";

/**
 * 409: the branch is the company's head office, so its state refuses the
 * delete. Deleting it left the company with no head office and no warning:
 * the saves in Empresas stopped mirroring onto it, and a branch created
 * later with the company's CNPJ silently became the "new" head office
 * (owner decision of 26/11/2026). Deactivating it stays allowed, since that
 * can be undone.
 */
class BranchHeadOfficeNotDeletableError extends AppError {
  constructor() {
    super(
      "A matriz não pode ser excluída: ela guarda os dados da própria empresa, que são editados em Empresas. Se ela não opera, desative-a.",
      409,
      "BRANCH_HEAD_OFFICE_NOT_DELETABLE",
    );
  }
}

export { BranchHeadOfficeNotDeletableError };
