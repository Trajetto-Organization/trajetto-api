class NotificationNotFoundError extends Error {
  constructor() {
    super("Notificação não encontrada! Por favor, tente novamente.");
  }
}

export { NotificationNotFoundError };
