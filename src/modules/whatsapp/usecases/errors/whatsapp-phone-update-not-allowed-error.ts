class WhatsAppPhoneUpdateNotAllowedError extends Error {
  constructor() {
    super(
      "Para alterar o número, primeiro desabilite as notificações WhatsApp",
    );
  }
}

export { WhatsAppPhoneUpdateNotAllowedError };
