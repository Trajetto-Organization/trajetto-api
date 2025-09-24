class VehicleChecklistNotBelongBusinessError extends Error {
  constructor() {
    super("Checklist veicular não pertence à esta empresa!");
  }
}

export { VehicleChecklistNotBelongBusinessError };
