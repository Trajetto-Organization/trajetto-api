class FineUserNotAllowedChangeError extends Error {
  constructor() {
    super("Você não tem permissão para alterar esta multa!");
  }
}

export { FineUserNotAllowedChangeError };
