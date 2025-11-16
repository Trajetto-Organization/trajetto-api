class FleetAnalyticsNotFoundError extends Error {
  constructor() {
    super("Análise de frota não encontrada!");
  }
}

export { FleetAnalyticsNotFoundError };
