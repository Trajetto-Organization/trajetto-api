import { AppError } from "@/shared/errors/AppError";

class NotificationNotFoundError extends AppError {
  constructor() {
    super(
      "Notificação não encontrada! Por favor, tente novamente.",
      404,
      "NOTIFICATION_NOT_FOUND",
    );
  }
}

export { NotificationNotFoundError };
