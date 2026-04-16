class VehicleChecklistNoChecklistsToExportError extends Error {
  constructor() {
    super("Não existem checklists veiculares para exportar!");
  }
}

export { VehicleChecklistNoChecklistsToExportError };
