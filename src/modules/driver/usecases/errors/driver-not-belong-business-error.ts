class DriverNotBelongBusinessError extends Error {
  constructor() {
    super("Este motorista não pertence a esta empresa!");
  }
}

export { DriverNotBelongBusinessError };
