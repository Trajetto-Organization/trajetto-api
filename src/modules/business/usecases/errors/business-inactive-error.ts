class BusinessInactiveError extends Error {
  constructor() {
    super(
      "Esta empresa está desativada. Entre em contato com o administrador para reativar o acesso.",
    );
  }
}

export { BusinessInactiveError };
