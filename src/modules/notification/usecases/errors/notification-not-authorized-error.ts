class NotificationNotAuthorizedError extends Error {
  constructor() {
    super("Acesso não autorizado à esta notificação!");
  }
}

export { NotificationNotAuthorizedError };
