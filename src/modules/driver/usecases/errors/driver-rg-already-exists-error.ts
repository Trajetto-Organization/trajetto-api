class DriverRgAlreadyExistsError extends Error {
  constructor() {
    super("Já existe um motorista cadastrado com este RG!");
  }
}

export { DriverRgAlreadyExistsError };
