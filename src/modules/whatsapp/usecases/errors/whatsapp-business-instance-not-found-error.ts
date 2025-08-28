class WhatsAppBusinessInstanceNotFoundError extends Error {
  constructor() {
    super(
      "Instância de negócio do WhatsApp não encontrada. Entre em contato com o suporte para configurar a instância principal.",
    );
  }
}

export { WhatsAppBusinessInstanceNotFoundError };
