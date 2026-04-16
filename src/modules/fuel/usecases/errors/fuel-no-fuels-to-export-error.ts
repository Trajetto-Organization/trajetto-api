class FuelNoFuelsToExportError extends Error {
  constructor() {
    super("Não existem abastecimentos para exportar!");
  }
}

export { FuelNoFuelsToExportError };
