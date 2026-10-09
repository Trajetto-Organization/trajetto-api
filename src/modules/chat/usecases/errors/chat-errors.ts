import { AppError } from "@/shared/errors/AppError";

/**
 * The chat's "não encontrado" answers: 404 with a code (decision 11.3).
 *
 * They used to be plain Errors that each controller mapped to a 400 with no
 * code — and not always the same way. As AppErrors the global handler
 * answers every one of them identically, whichever route raises it.
 *
 * "Of another company" is always the same answer as "does not exist": a
 * different status or sentence would tell a caller that an id is real in
 * some other tenant.
 */
class ChatThreadNotFoundError extends AppError {
  constructor() {
    super(
      "Conversa não encontrada! Por favor, tente novamente.",
      404,
      "CHAT_THREAD_NOT_FOUND",
    );
    this.name = "ChatThreadNotFoundError";
  }
}

class ChatMessageNotFoundError extends AppError {
  constructor() {
    super("Mensagem não encontrada.", 404, "CHAT_MESSAGE_NOT_FOUND");
    this.name = "ChatMessageNotFoundError";
  }
}

class ChatDriverNotFoundError extends AppError {
  constructor() {
    super(
      "Motorista não encontrado para esta conversa.",
      404,
      "CHAT_DRIVER_NOT_FOUND",
    );
    this.name = "ChatDriverNotFoundError";
  }
}

/** The delivery cited in the chip: missing, of another company or driver. */
class ChatDeliveryNotFoundError extends AppError {
  constructor() {
    super("Entrega não encontrada.", 404, "CHAT_DELIVERY_NOT_FOUND");
    this.name = "ChatDeliveryNotFoundError";
  }
}

/** An explicit `routeId` that is missing or of another company. */
class ChatRouteNotFoundError extends AppError {
  constructor() {
    super("Rota não encontrada.", 404, "CHAT_ROUTE_NOT_FOUND");
    this.name = "ChatRouteNotFoundError";
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
  ChatDeliveryNotFoundError,
  ChatRouteNotFoundError,
  ChatDeliveryReceiptNotAllowedError,
};
