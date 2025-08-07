class DriverCpfAlreadyExistsError extends Error {
  constructor() {
    super("Já existe um motorista cadastrado com este CPF!");
  }
}

export { DriverCpfAlreadyExistsError };
