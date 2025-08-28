class WhatsAppBusinessNotConnected extends Error {
  constructor() {
    super(
      "A instância de negócio do WhatsApp não está conectada. Entre em contato com o suporte.",
    );
  }
}

export { WhatsAppBusinessNotConnected };
