class DriverLicenseAlreadyExistsError extends Error {
  constructor() {
    super(
      "Esta CNH não está disponível para cadastro. As CNHs de motoristas devem ser únicas em todo o sistema.",
    );
  }
}

export { DriverLicenseAlreadyExistsError };
