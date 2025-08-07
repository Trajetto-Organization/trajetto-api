class WhatsAppPhoneAlreadyInUseError extends Error {
  constructor() {
    super("Este número já está sendo utilizado por outro usuário conectado");
    this.name = "WhatsAppPhoneAlreadyInUseError";
  }
}

export { WhatsAppPhoneAlreadyInUseError };
