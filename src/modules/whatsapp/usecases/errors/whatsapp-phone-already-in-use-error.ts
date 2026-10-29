import { AppError } from "@/shared/errors/AppError";

class WhatsAppPhoneAlreadyInUseError extends AppError {
  constructor() {
    super(
      "Este número já está sendo utilizado por outro usuário conectado",
      409,
      "WHATSAPP_PHONE_TAKEN",
    );
    this.name = "WhatsAppPhoneAlreadyInUseError";
  }
}

export { WhatsAppPhoneAlreadyInUseError };
