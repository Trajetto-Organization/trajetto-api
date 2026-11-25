import { AppError } from "@/shared/errors/AppError";

/**
 * 409: the branch is the company's head office, a mirror of the company's
 * own record, so its state refuses an edit through Filiais (see
 * branch-head-office.ts).
 */
class BranchHeadOfficeReadOnlyError extends AppError {
  constructor() {
    super(
      "Esta filial é a matriz e espelha o cadastro da empresa: os dados dela só mudam em Empresas, pelo administrador da plataforma.",
      409,
      "BRANCH_HEAD_OFFICE_READ_ONLY",
    );
  }
}

export { BranchHeadOfficeReadOnlyError };
