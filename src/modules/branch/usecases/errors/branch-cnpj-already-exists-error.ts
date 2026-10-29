import { AppError } from "@/shared/errors/AppError";

/**
 * The CNPJ is the branch's national identity and stays unique across the
 * platform (decision 8.1). So the message must not say where it is taken:
 * naming another carrier, or even confirming that one has it, would let a
 * caller probe other tenants' registrations.
 */
class BranchCnpjAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Este CNPJ não está disponível para cadastro. Se a filial já é da sua empresa, procure-a na listagem; se não, fale com o suporte.",
      409,
      "BRANCH_CNPJ_UNAVAILABLE",
    );
  }
}

export { BranchCnpjAlreadyExistsError };
