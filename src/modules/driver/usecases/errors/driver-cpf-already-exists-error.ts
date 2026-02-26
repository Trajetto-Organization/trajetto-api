class DriverCpfAlreadyExistsError extends Error {
  constructor() {
    super(
      "Este CPF não está disponível para cadastro. Os CPFs de motoristas devem ser únicos em todo o sistema.",
    );
  }
}

export { DriverCpfAlreadyExistsError };
