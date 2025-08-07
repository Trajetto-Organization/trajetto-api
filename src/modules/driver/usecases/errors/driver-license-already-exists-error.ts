class DriverLicenseAlreadyExistsError extends Error {
  constructor() {
    super("Já existe um motorista cadastrado com este CNH!");
  }
}

export { DriverLicenseAlreadyExistsError };
