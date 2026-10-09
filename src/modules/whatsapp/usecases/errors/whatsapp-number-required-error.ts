import { AppError } from "@/shared/errors/AppError";

class WhatsAppNumberRequiredError extends AppError {
  constructor() {
    super("O número de telefone é obrigatório para habilitar WhatsApp", 400, "WHATSAPP_NUMBER_REQUIRED");
  }
}

export { WhatsAppNumberRequiredError };
