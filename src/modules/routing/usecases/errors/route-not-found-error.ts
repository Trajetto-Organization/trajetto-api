class RouteNotFoundError extends Error {
  constructor() {
    super("Rota não encontrada!");
  }
}

export { RouteNotFoundError };
