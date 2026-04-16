class BranchInactiveError extends Error {
  constructor() {
    super(
      "Esta filial está desativada. Entre em contato com o administrador para reativar o acesso.",
    );
  }
}

export { BranchInactiveError };
