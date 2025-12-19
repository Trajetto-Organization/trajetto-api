class AccountPayableNotAllowedTransferCompaniesError extends Error {
  constructor() {
    super("Você não tem permissão para transferir contas entre empresas!");
  }
}

export { AccountPayableNotAllowedTransferCompaniesError };
