class BusinessEmailAlreadyExistsError extends Error {
  constructor() {
    super("Este e-mail já foi cadastrado em uma empresa!");
  }
}

export { BusinessEmailAlreadyExistsError };
