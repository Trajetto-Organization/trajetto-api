class WhatsAppAlreadyConnectedError extends Error {
  constructor() {
    super("WhatsApp já está conectado");
  }
}

export { WhatsAppAlreadyConnectedError };
