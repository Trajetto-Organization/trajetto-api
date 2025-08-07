class WhatsAppNumberRequiredError extends Error {
  constructor() {
    super("O número de telefone é obrigatório para habilitar WhatsApp");
  }
}

export { WhatsAppNumberRequiredError };
