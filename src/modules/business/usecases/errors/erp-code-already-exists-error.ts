class ErpCodeAlreadyExistsError extends Error {
  constructor() {
    super("Este código erp já foi cadastrado em uma empresa!");
  }
}

export { ErpCodeAlreadyExistsError };
