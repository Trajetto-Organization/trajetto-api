class SimulationNotFoundError extends Error {
  constructor() {
    super("Simulação não encontrada!");
  }
}

export { SimulationNotFoundError };
