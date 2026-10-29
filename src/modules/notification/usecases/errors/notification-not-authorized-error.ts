import { AppError } from "@/shared/errors/AppError";

/**
 * Someone else's notification answers exactly like a missing one (decision
 * 11.3): a separate "not yours" refusal would confirm which ids exist.
 */
class NotificationNotAuthorizedError extends AppError {
  constructor() {
    super(
      "Notificação não encontrada! Por favor, tente novamente.",
      404,
      "NOTIFICATION_NOT_FOUND",
    );
  }
}

export { NotificationNotAuthorizedError };
