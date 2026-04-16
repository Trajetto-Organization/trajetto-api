class VehicleNoVehiclesToExportError extends Error {
  constructor() {
    super("Não existem veículos para exportar!");
  }
}

export { VehicleNoVehiclesToExportError };
