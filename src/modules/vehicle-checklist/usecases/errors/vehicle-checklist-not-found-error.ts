class VehicleChecklistNotFoundError extends Error {
  constructor() {
    super("Checklist veicular não encontrado!");
  }
}

export { VehicleChecklistNotFoundError };
