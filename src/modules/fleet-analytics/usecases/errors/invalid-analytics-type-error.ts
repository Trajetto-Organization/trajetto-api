class InvalidAnalyticsTypeError extends Error {
  constructor() {
    super(
      "Tipo de análise inválido! Tipos válidos: route_efficiency, cost_analysis, vehicle_utilization, fuel_consumption, maintenance_cost",
    );
  }
}

export { InvalidAnalyticsTypeError };
