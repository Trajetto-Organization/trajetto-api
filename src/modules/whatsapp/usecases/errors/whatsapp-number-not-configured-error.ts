class WhatsAppNumberNotConfiguredError extends Error {
  constructor() {
    super("O número de telefone não está configurado");
  }
}

export { WhatsAppNumberNotConfiguredError };
