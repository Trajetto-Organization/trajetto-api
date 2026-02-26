class DriverRgAlreadyExistsError extends Error {
  constructor() {
    super(
      "Este RG não está disponível para cadastro. Os RGs de motoristas devem ser únicos em todo o sistema.",
    );
  }
}

export { DriverRgAlreadyExistsError };
