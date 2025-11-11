class VehicleAlreadyAssignedError extends Error {
  constructor() {
    super("Veículo já está atribuído para esta data e horário!");
  }
}

export { VehicleAlreadyAssignedError };
