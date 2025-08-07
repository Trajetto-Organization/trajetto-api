class PartNotBelongServiceOrderError extends Error {
  constructor() {
    super("Esta peça não pertence a esta ordem de serviço!");
  }
}

export { PartNotBelongServiceOrderError };
