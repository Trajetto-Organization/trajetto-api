class EmailAlreadyExistsError extends Error {
  constructor() {
    super("Este e-mail já foi cadastrado em uma empresa!");
  }
}

export { EmailAlreadyExistsError };
