class WhatsAppNotConfiguredError extends Error {
  constructor() {
    super("WhatsApp não configurado. Configure primeiro nas configurações.");
  }
}

export { WhatsAppNotConfiguredError };
