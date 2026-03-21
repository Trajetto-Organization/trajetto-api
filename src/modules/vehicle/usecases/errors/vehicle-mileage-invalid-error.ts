class VehicleMileageInvalidError extends Error {
  constructor() {
    super(
      "A quilometragem informada deve ser maior que a quilometragem atual do veículo!",
    );
  }
}

export { VehicleMileageInvalidError };
