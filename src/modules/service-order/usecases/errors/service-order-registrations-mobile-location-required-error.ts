class ServiceOrderRegistrationsMobileLocationRequiredError extends Error {
  constructor() {
    super("Para registros via aplicativo mobile, a localização é obrigatória.");
  }
}

export { ServiceOrderRegistrationsMobileLocationRequiredError };
