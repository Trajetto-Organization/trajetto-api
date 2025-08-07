class ServiceOrderPartAlreadyExistsError extends Error {
  constructor() {
    super("Esta peça já foi adicionada a esta ordem de serviço!");
  }
}

export { ServiceOrderPartAlreadyExistsError };
