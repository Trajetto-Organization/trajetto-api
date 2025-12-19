class ServiceOrderNewMileageRequireOrderFinalizedError extends Error {
  constructor() {
    super(
      "A nova quilometragem é obrigatória quando a ordem de serviço é finalizada",
    );
  }
}

export { ServiceOrderNewMileageRequireOrderFinalizedError };
