import { AppError } from "@/shared/errors/AppError";

class ChatThreadNotFoundError extends Error {
  constructor() {
    super("Conversa não encontrada! Por favor, tente novamente.");
  }
}

class ChatMessageNotFoundError extends Error {
  constructor() {
    super("Mensagem não encontrada.");
    this.name = "ChatMessageNotFoundError";
  }
}

class ChatDriverNotFoundError extends Error {
  constructor() {
    super("Motorista não encontrado para esta conversa.");
  }
}

class ChatDriverNotBelongBusinessError extends Error {
  constructor() {
    super("Este motorista não pertence à sua empresa.");
  }
}

/**
 * Only the owner of the device may say the device received it. A delivery
 * receipt from the SAC would claim the driver's phone holds a message that
 * nobody ever handed to it. It carries a status code because the refusal is
 * an authorization answer, not a validation one.
 */
class ChatDeliveryReceiptNotAllowedError extends AppError {
  constructor() {
    super(
      "Somente o aparelho do motorista confirma a entrega de uma mensagem.",
      403,
      "CHAT_DELIVERY_RECEIPT_NOT_ALLOWED",
    );
  }
}

export {
  ChatThreadNotFoundError,
  ChatMessageNotFoundError,
  ChatDriverNotFoundError,
  ChatDriverNotBelongBusinessError,
  ChatDeliveryReceiptNotAllowedError,
};
