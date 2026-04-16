class DriverNoDriversToExportError extends Error {
  constructor() {
    super("Não existem motoristas para exportar!");
  }
}

export { DriverNoDriversToExportError };
