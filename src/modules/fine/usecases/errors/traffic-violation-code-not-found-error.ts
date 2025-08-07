class TrafficViolationCodeNotFoundError extends Error {
  constructor() {
    super("Código de infração não encontrado!");
  }
}

export { TrafficViolationCodeNotFoundError };
