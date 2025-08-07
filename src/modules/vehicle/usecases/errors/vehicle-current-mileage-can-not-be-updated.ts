class VehicleCurrentMileageCanNotBeUpdatedError extends Error {
  constructor() {
    super(
      "A quilometragem atual não pode ser atualizada por ser um campo de somente leitura!",
    );
  }
}

export { VehicleCurrentMileageCanNotBeUpdatedError };
