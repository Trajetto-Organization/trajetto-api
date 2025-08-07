class ServiceOrderNotBelongBusinessError extends Error {
  constructor() {
    super("Esta ordem de serviço não pertence a esta empresa!");
  }
}

export { ServiceOrderNotBelongBusinessError };
