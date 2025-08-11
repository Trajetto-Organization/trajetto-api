class VehicleMileageInvalidError extends Error {
  constructor() {
    super("A quilometragem informada não pode ser menor que a quilometragem atual do veículo!");
  }
}

export { VehicleMileageInvalidError };