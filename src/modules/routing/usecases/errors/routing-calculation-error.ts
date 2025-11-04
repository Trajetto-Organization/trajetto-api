class RoutingCalculationError extends Error {
  constructor(message?: string) {
    super(
      message ||
        "Erro ao calcular rota. Verifique as coordenadas e tente novamente.",
    );
  }
}

export { RoutingCalculationError };
