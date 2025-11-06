class SimulationProcessingError extends Error {
  constructor(message: string = "Erro ao processar simulação!") {
    super(message);
  }
}

export { SimulationProcessingError };
