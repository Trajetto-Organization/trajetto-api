class ServiceOrderPartNotFoundError extends Error {
  constructor() {
    super("Peça da ordem de serviço não encontrada!");
  }
}

export { ServiceOrderPartNotFoundError };
