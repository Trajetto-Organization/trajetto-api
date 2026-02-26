class FuelTypeAlreadyExistsError extends Error {
  constructor() {
    super(
      "Este tipo de combustível não está disponível para cadastro. Já existe um tipo de combustível com este nome.",
    );
  }
}

export { FuelTypeAlreadyExistsError };
