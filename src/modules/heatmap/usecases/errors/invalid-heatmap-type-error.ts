class InvalidHeatmapTypeError extends Error {
  constructor() {
    super(
      "Tipo de heatmap inválido! Valores permitidos: fines, fuel, maintenance.",
    );
  }
}

export { InvalidHeatmapTypeError };
