class BusinessCnpjAlreadyExistsError extends Error {
  constructor() {
    super("Este cnpj já foi cadastrado em uma empresa!");
  }
}

export { BusinessCnpjAlreadyExistsError };
