class VehicleNotAssignedToDriverError extends Error {
  constructor() {
    super(
      "Você não tem permissão para acessar este veículo. Este veículo não está atribuído a você.",
    );
  }
}

export { VehicleNotAssignedToDriverError };
