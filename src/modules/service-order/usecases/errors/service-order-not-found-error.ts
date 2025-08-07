class ServiceOrderNotFoundError extends Error {
  constructor() {
    super("Ordem de serviço não encontrada!");
  }
}

export { ServiceOrderNotFoundError };
