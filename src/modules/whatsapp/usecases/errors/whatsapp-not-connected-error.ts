class WhatsAppNotConnectedError extends Error {
  constructor() {
    super("WhatsApp não está habilitado. Habilite primeiro nas configurações.");
  }
}

export { WhatsAppNotConnectedError };
